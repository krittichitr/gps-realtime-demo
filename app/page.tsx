'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { GoogleMap, useJsApiLoader, Marker, Circle, DirectionsRenderer, OverlayView } from '@react-google-maps/api'
import { supabase } from '@/lib/supabase'

const containerStyle = {
  width: '100%',
  height: '100vh'
};

// กำหนดเขตปลอดภัย (Geofence) - Demo
// HOME_LAT, HOME_LNG เริ่มต้น
const defaultCenter = {
  lat: 13.7649,
  lng: 100.5383
};

const SAFE_ZONE_WARNING = 20; // meters (Yellow) - Reduced for testing
const SAFE_ZONE_DANGER = 50; // meters (Red) - Reduced for testing

export default function Home() {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ''
  })

  // State
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [markerPosition, setMarkerPosition] = useState(defaultCenter)
  const [statusInfo, setStatusInfo] = useState({ label: "ปกติ: อยู่ในเขตปลอดภัย", color: "bg-green-500", pulse: "" }) 
  const [directionsResponse, setDirectionsResponse] = useState<google.maps.DirectionsResult | null>(null)
  const [currentDistance, setCurrentDistance] = useState(0)
  
  // เพิ่ม state สำหรับจุดศูนย์กลาง Safe Zone ที่เปลี่ยนได้
  const [safeZoneCenter, setSafeZoneCenter] = useState(defaultCenter)
  // State สำหรับตำแหน่งผู้ดูแล (Admin)
  const [adminLocation, setAdminLocation] = useState<google.maps.LatLngLiteral | null>(null)
  const [adminHeading, setAdminHeading] = useState<number>(0) // เข็มทิศ
  
  // State สำหรับโหมดนำทาง (Driver Mode)
  const [isNavigating, setIsNavigating] = useState(false)
  
  // State สำหรับล็อคหน้าจอ (Auto-Center) - ใช้สำหรับติดตามผู้ป่วย
  const [isAutoCenter, setIsAutoCenter] = useState(true)
  
  // Ref for accessing latest admin location inside callbacks without re-subscribing
  const adminLocationRef = useRef<google.maps.LatLngLiteral | null>(null);
  
  // Sync Ref
  useEffect(() => {
    adminLocationRef.current = adminLocation;
  }, [adminLocation]);

  const onLoad = useCallback(function callback(map: google.maps.Map) {
    setMap(map)
  }, [])

  const onUnmount = useCallback(function callback(map: google.maps.Map) {
    setMap(null)
  }, [])

  // ติดตามตำแหน่งผู้ดูแล (Admin)
  useEffect(() => {
    if ("geolocation" in navigator) {
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const adminPos = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          };
          setAdminLocation(adminPos);
          if (pos.coords.heading) {
            setAdminHeading(pos.coords.heading);
          }
        }, 
        (err) => console.error("Admin location error:", err), 
        { enableHighAccuracy: true }
      );

      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  // Effect สำหรับโหมดนำทาง (Driver Mode)
  useEffect(() => {
    if (isNavigating && adminLocation && map) {
        // 1. ย้ายกล้องไปหา Admin (ตัวคุณ)
        map.panTo(adminLocation);
        
        // 2. ปรับมุมกล้องให้เหมือน GPS
        map.setZoom(20); // Zoom ใกล้สุด
        map.setTilt(45); // เอียง 3D
        map.setHeading(adminHeading); // หมุนตามเข็มทิศ
        
        // 3. ปิด Auto-Center ของผู้ป่วยชั่วคราว เพื่อไม่ให้กล้องตีกัน
        if (isAutoCenter) setIsAutoCenter(false);
    }
  }, [isNavigating, adminLocation, adminHeading, map]);

  // ฟังก์ชันคำนวณระยะทาง
  const getDistanceFromLatLonInM = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; 
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c; 
    return d * 1000; 
  }

  const deg2rad = (deg: number) => {
    return deg * (Math.PI / 180)
  }

  // คำนวณเส้นทาง
  const calculateRoute = (origin: google.maps.LatLngLiteral, destination: google.maps.LatLngLiteral) => {
    if (!window.google) return;
    const directionsService = new google.maps.DirectionsService();
    directionsService.route(
      {
        origin: origin,      
        destination: destination, 
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (status === "OK" && result) {
          setDirectionsResponse(result); 
        } else {
          console.error(`Directions request failed due to ${status}`);
        }
      }
    );
  };

  // Status Logic
  const getStatus = (distance: number) => {
    if (distance > SAFE_ZONE_DANGER) return { label: "อันตราย: ออกนอกเขต!", color: "bg-red-600", pulse: "animate-ping" };
    if (distance > SAFE_ZONE_WARNING) return { label: "คำเตือน: ออกนอกเขตชั้นใน", color: "bg-yellow-500", pulse: "" };
    return { label: "ปกติ: อยู่ในเขตปลอดภัย", color: "bg-green-500", pulse: "" };
  };

  // Check Geofence
  const checkGeofence = (lat: number, lng: number) => {
    const distance = getDistanceFromLatLonInM(lat, lng, safeZoneCenter.lat, safeZoneCenter.lng);
    setCurrentDistance(distance);
    
    // อัปเดตสถานะ
    const newStatus = getStatus(distance);
    setStatusInfo(newStatus);
    
    // ถ้าเป็นระยะ Danger ให้คำนวณเส้นทางใหม่ทันที (หรือถ้ากำลังนำทางอยู่ก็ต้องคำนวณตลอด)
    if (distance > SAFE_ZONE_DANGER || isNavigating) {
        const origin = adminLocationRef.current || safeZoneCenter;
        calculateRoute(origin, { lat, lng });
    } else {
        if (!isNavigating) setDirectionsResponse(null); // ถ้าไม่ได้นำทาง และปลอดภัย ให้ลบเส้น
    }
  }

  // อัปเดตตำแหน่ง Marker (Patient)
  const updateMarkerPosition = (lat: number, lng: number) => {
    const newPos = { lat, lng };
    setMarkerPosition(newPos);
    
    localStorage.setItem('lastPatientLat', lat.toString());
    localStorage.setItem('lastPatientLng', lng.toString());
    
    // Pan map to Patient ONLY if Auto-Center is ON AND NOT Navigating
    if (isAutoCenter && !isNavigating) {
      map?.panTo(newPos);
    }
  }

  useEffect(() => {
    // 1. ดึงข้อมูลล่าสุดเมื่อโหลดหน้าเว็บ
    const fetchLatestLocation = async () => {
      const { data } = await supabase
        .from('locations')
        .select('*')
        .eq('id', 1) 
        .single();
      
      if (data) {
        updateMarkerPosition(data.lat, data.lng);
        checkGeofence(data.lat, data.lng);
      }
    };

    fetchLatestLocation();

    // 2. สมัครรับข้อมูล Real-time Subscription
    const locationChannel = supabase
      .channel('public:locations')
      .on(
        'postgres_changes', 
        { event: '*', schema: 'public', table: 'locations' }, 
        (payload: any) => {
          const { lat, lng } = payload.new;
          updateMarkerPosition(lat, lng);
          checkGeofence(lat, lng);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(locationChannel);
    }
  }, [map, safeZoneCenter, isAutoCenter]); // Add isAutoCenter dependency 

  if (loadError) return <div className="p-10 text-red-500">Error loading maps. Check API Key.</div>;
  if (!isLoaded) return <div className="p-10">Loading Map...</div>;

  // Helper for text color
  const distanceColor = (d: number) => {
    if (d > SAFE_ZONE_DANGER) return 'text-red-600';
    if (d > SAFE_ZONE_WARNING) return 'text-yellow-600';
    return 'text-green-600';
  }

  return (
    <div className="relative w-full h-screen bg-gray-100">

      {/* --- Mobile-First Redesign --- */}

      {/* 1. Top Status Pill (Compact) */}
      <div className="fixed top-4 left-4 right-4 z-[1000] flex justify-center pointer-events-none">
        <div className={`pointer-events-auto bg-white/90 backdrop-blur-md px-4 py-2 rounded-full shadow-lg border border-gray-100 flex items-center gap-3 transition-all ${statusInfo.color === 'bg-red-600' ? 'ring-2 ring-red-500 ring-offset-2' : ''}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${statusInfo.color} ${statusInfo.pulse && 'animate-pulse'}`}></div>
            <span className={`text-sm font-bold ${statusInfo.color === 'bg-red-600' ? 'text-red-600' : 'text-gray-700'}`}>
                {statusInfo.label}
            </span>
        </div>
      </div>

      {/* 2. Floating Map Controls (Right Side) */}
      <div className="fixed right-4 bottom-[240px] md:bottom-8 z-[1000] flex flex-col gap-3">
         {/* Auto Center Toggle */}
         <button 
            onClick={() => setIsAutoCenter(!isAutoCenter)}
            className={`w-12 h-12 rounded-full shadow-xl flex items-center justify-center transition-all active:scale-95 ${
                isAutoCenter ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
        >
            {isAutoCenter ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                    <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l1.664 1.664M21 21l-1.5-1.5m-5.485-1.242L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0c1.1.128 1.907 1.077 1.907 2.185V19.5M4.664 4.664L19.5 19.5" />
                </svg>
            )}
         </button>
      </div>

      {/* 3. Bottom Sheet Info Card */}
      <div className="fixed bottom-0 left-0 right-0 z-[1000] bg-white rounded-t-3xl shadow-[0_-5px_20px_rgba(0,0,0,0.1)] p-6 pb-8 md:w-96 md:rounded-2xl md:bottom-6 md:left-6 md:right-auto md:pb-6 transition-all transform duration-300 ease-out">
        {/* Drag Handle (Mobile only styling detail) */}
        <div className="w-12 h-1.5 bg-gray-200 rounded-full mx-auto mb-6 md:hidden"></div>

        <div className="flex items-start justify-between mb-6">
            <div>
                <h2 className="text-2xl font-bold text-gray-900 leading-tight">ผู้ป่วย</h2>
                <div className="flex items-center gap-1 text-gray-400 text-sm font-medium mt-1">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.006.003.003.001zM10 13a4 4 0 100-8 4 4 0 000 8z" clipRule="evenodd" />
                    </svg>
                    <span>{markerPosition.lat.toFixed(5)}, {markerPosition.lng.toFixed(5)}</span>
                </div>
            </div>
            
            <div className="text-right">
                <p className="text-sm text-gray-400 mb-0.5">ระยะห่าง</p>
                <p className={`text-2xl font-black ${distanceColor(currentDistance)}`}>
                    {currentDistance < 1000 ? currentDistance.toFixed(0) : (currentDistance/1000).toFixed(2)} 
                    <span className="text-sm font-normal text-gray-400 ml-1">{currentDistance < 1000 ? 'ม.' : 'กม.'}</span>
                </p>
            </div>
        </div>

        {/* Action Button: Live Navigation */}
        <button 
            onClick={() => {
                if (!adminLocation) {
                    alert("กำลังระบุตำแหน่งของคุณ... กรุณารอสักครู่");
                    return;
                }
                setIsNavigating(!isNavigating);
            }}
            className={`w-full ${isNavigating ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'} text-white text-lg font-bold py-4 rounded-xl shadow-xl transition-all flex items-center justify-center gap-2 group mb-3`}
        >
            {isNavigating ? (
                <>
                <span className="animate-pulse">🔴 กำลังนำทางสด...</span>
                <span className="text-sm font-normal opacity-80">(แตะเพื่อหยุด)</span>
                </>
            ) : (
                <>
                <span>เริ่มนำทางสด (Live GPS)</span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                 <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                 <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                </svg>
                </>
            )}
        </button>
        
        {/* External Link */}
        <button
            onClick={() => {
                const originLat = adminLocation ? adminLocation.lat : safeZoneCenter.lat;
                const originLng = adminLocation ? adminLocation.lng : safeZoneCenter.lng;
                const url = `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLng}&destination=${markerPosition.lat},${markerPosition.lng}&travelmode=driving`;
                window.open(url, '_blank');
            }}
            className="w-full text-blue-600 font-medium py-2 rounded-lg hover:bg-blue-50 transition-all flex items-center justify-center gap-2 text-sm"
        >
            หรือเปิดใน Google Maps App (ไม่ Real-time) ↗
        </button>

        {/* Desktop Only: Save Config Button (Small link at bottom) */}
        <div className="hidden md:block mt-4 text-center">
             <button
                onClick={async () => {
                    const { error } = await supabase
                        .from('safe_zones')
                        .upsert({ 
                            id: 'current_user_config', 
                            center_lat: safeZoneCenter.lat, 
                            center_lng: safeZoneCenter.lng,
                            radius_1: SAFE_ZONE_WARNING,
                            radius_2: SAFE_ZONE_DANGER
                        });
                    if (!error) alert("บันทึกจุดปลอดภัยเรียบร้อย!");
                }}
                className="text-xs text-blue-500 hover:text-blue-700 underline"
             >
                บันทึกตำแหน่ง Safe Zone ปัจจุบัน
             </button>
        </div>
      </div>

      <GoogleMap
        mapContainerStyle={containerStyle}
        center={defaultCenter} // ใช้ center เริ่มต้น (map.panTo จะคุมต่อ)
        zoom={16}
        onLoad={onLoad}
        onUnmount={onUnmount}
        onDragStart={() => setIsAutoCenter(false)} // ถ้าผู้ใช้ลากแผนที่ ให้ยกเลิก Auto Center ทันที
        onClick={(e) => {
            if (e.latLng) {
                setSafeZoneCenter({ lat: e.latLng.lat(), lng: e.latLng.lng() });
            }
        }}
        options={{
            disableDefaultUI: false,
            zoomControl: true,
            mapTypeControl: false,
            fullscreenControl: false,
            streetViewControl: false,
            styles: [
                {
                    featureType: "poi",
                    stylers: [{ visibility: "off" }]
                }
            ]
        }}
      >
        {/* Patient Marker (Standard Google Pin) */}
        <Marker 
            position={markerPosition} 
            animation={window.google?.maps?.Animation?.DROP}
        />

        {/* Marker แสดงตำแหน่งผู้ดูแล (Admin) - สีน้ำเงิน */}
        {adminLocation && window.google && (
          <Marker
            position={adminLocation}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              fillColor: "#4285F4", // สีฟ้า Google
              fillOpacity: 1,
              strokeColor: "white",
              strokeWeight: 2,
              scale: 8, // ขนาดของจุด
            }}
            title="ตำแหน่งของคุณ (Admin)"
          />
        )}
        
        {/* วงกลมชั้นที่ 1 (เตือน) */}
        <Circle 
          center={safeZoneCenter} 
          radius={SAFE_ZONE_WARNING}
          options={{
            strokeColor: "#FFC107", 
            strokeOpacity: 0.8,
            strokeWeight: 2,
            fillColor: "#FFC107",
            fillOpacity: 0.2,
            clickable: false,
            draggable: false,
            editable: false,
            visible: true,
          }}
        />

        {/* วงกลมชั้นที่ 2 (อันตราย) */}
        <Circle 
          center={safeZoneCenter} 
          radius={SAFE_ZONE_DANGER}
          options={{
            strokeColor: "#ea4335", // สีแดง Google
            strokeOpacity: 0.8,
            strokeWeight: 1,
            fillColor: "#ea4335",
            fillOpacity: 0.1,
            clickable: false,
            draggable: false,
            editable: false,
            visible: true,
          }}
        />

        {/* แสดงเส้นทางเมื่อออกนอกเขต */}
        {directionsResponse && (
          <DirectionsRenderer 
            directions={directionsResponse}
            options={{
              suppressMarkers: true, // ไม่ต้องแสดง A/B ซ้ำ เพราะมี Marker แล้ว
              polylineOptions: {
                strokeColor: '#ef4444',
                strokeWeight: 5,
                strokeOpacity: 0.8
              }
            }}
          />
        )}
      </GoogleMap>
    </div>
  )
}
