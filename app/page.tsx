'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { GoogleMap, useJsApiLoader, Marker, Circle, DirectionsRenderer } from '@react-google-maps/api'
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
  const [statusInfo, setStatusInfo] = useState({ label: "ปกติ: อยู่ในเขตปลอดภัย", color: "bg-green-500", pulse: "" }) // New Status State
  const [directionsResponse, setDirectionsResponse] = useState<google.maps.DirectionsResult | null>(null)
  const [currentDistance, setCurrentDistance] = useState(0)
  
  // เพิ่ม state สำหรับจุดศูนย์กลาง Safe Zone ที่เปลี่ยนได้
  const [safeZoneCenter, setSafeZoneCenter] = useState(defaultCenter)
  // State สำหรับตำแหน่งผู้ดูแล (Admin)
  const [adminLocation, setAdminLocation] = useState<google.maps.LatLngLiteral | null>(null)
  
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
        }, 
        (err) => console.error("Admin location error:", err), 
        { enableHighAccuracy: true }
      );

      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  // ฟังก์ชันคำนวณระยะทาง (Haversine Formula)
  const getDistanceFromLatLonInM = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c; // Distance in km
    return d * 1000; // Distance in meters
  }

  const deg2rad = (deg: number) => {
    return deg * (Math.PI / 180)
  }

  // ฟังก์ชันคำนวณเส้นทาง (Refactored)
  const calculateRoute = (origin: google.maps.LatLngLiteral, destination: google.maps.LatLngLiteral) => {
    if (!window.google) return;

    const directionsService = new google.maps.DirectionsService();

    directionsService.route(
      {
        origin: origin,      // พิกัด MacBook (ผู้ดูแล)
        destination: destination, // พิกัดล่าสุดจากมือถือ (ผู้ป่วย)
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        if (status === "OK" && result) {
          setDirectionsResponse(result); // เส้นสีฟ้าจะเปลี่ยนรูปร่างตามพิกัดใหม่ทันที
        } else {
          console.error(`Directions request failed due to ${status}`);
        }
      }
    );
  };

  // Logic การกำหนดสถานะ
  const getStatus = (distance: number) => {
    if (distance > SAFE_ZONE_DANGER) return { label: "อันตราย: ออกนอกเขต!", color: "bg-red-600", pulse: "animate-ping" };
    if (distance > SAFE_ZONE_WARNING) return { label: "คำเตือน: ออกนอกเขตชั้นใน", color: "bg-yellow-500", pulse: "" };
    return { label: "ปกติ: อยู่ในเขตปลอดภัย", color: "bg-green-500", pulse: "" };
  };

  // ฟังก์ชันเช็ค Geofence (ปรับให้เรียก calculateRoute ถ้าจำเป็น)
  const checkGeofence = (lat: number, lng: number) => {
    const distance = getDistanceFromLatLonInM(lat, lng, safeZoneCenter.lat, safeZoneCenter.lng);
    setCurrentDistance(distance);
    
    // อัปเดตสถานะ (3 ระดับ)
    const newStatus = getStatus(distance);
    setStatusInfo(newStatus);
    
    console.log(`Distance: ${distance.toFixed(2)}m, Status: ${newStatus.label}`);

    // ถ้าเป็นระยะ Danger ให้คำนวณเส้นทางใหม่ทันที (Real-time Navigation)
    if (distance > SAFE_ZONE_DANGER) {
        // ใช้ตำแหน่ง Admin ล่าสุด (ถ้ามี) หรือ Safe Zone ถ้าไม่มี
        const origin = adminLocationRef.current || safeZoneCenter;
        calculateRoute(origin, { lat, lng });
    } else {
        setDirectionsResponse(null);
    }
  }

  // ฟังก์ชันอัปเดตตำแหน่ง Marker
  const updateMarkerPosition = (lat: number, lng: number) => {
    const newPos = { lat, lng };
    setMarkerPosition(newPos);
    map?.panTo(newPos);
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

    // 2. สมัครรับข้อมูล Real-time Subscription (ฟังข้อมูลสดจาก Supabase)
    const locationChannel = supabase
      .channel('public:locations')
      .on(
        'postgres_changes', 
        { event: '*', schema: 'public', table: 'locations' }, 
        (payload: any) => {
          const { lat, lng } = payload.new;
          
          // อัปเดตตำแหน่งผู้ป่วยใน State และ เช็คเงื่อนไขทันที
          updateMarkerPosition(lat, lng);
          checkGeofence(lat, lng);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(locationChannel);
    }
  }, [map, safeZoneCenter]); 

  if (loadError) return <div className="p-10 text-red-500">Error loading maps. Check API Key.</div>;
  if (!isLoaded) return <div className="p-10">Loading Map...</div>;

  return (
    <div className="relative w-full h-screen bg-gray-100">

      {/* หน้าจอแจ้งเตือนสถานะแบบ Real-time */}
      <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[1000] p-4 rounded-2xl shadow-2xl flex items-center gap-4 transition-all duration-500 ${statusInfo.color} text-white`}>
        {/* จุดไฟกระพริบเมื่ออยู่นอกเขต */}
        <div className={`w-3 h-3 rounded-full bg-white ${statusInfo.pulse}`}></div>
        
        <div className="flex flex-col">
          <span className="text-xs opacity-80 font-medium uppercase tracking-wider">Status</span>
          <span className="text-xl font-bold">{statusInfo.label}</span>
          <span className="text-sm">ระยะห่าง: {currentDistance.toFixed(0)} เมตร</span>
        </div>
      </div>
      
      {/* UI Overlay (Glassmorphism) */}
      <div className="absolute top-4 left-4 z-10 w-80 p-6 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 shadow-xl text-gray-800">
        <h1 className="text-2xl font-bold mb-1 text-gray-900">GPS Tracker</h1>
        <p className="text-xs text-gray-500 mb-4 uppercase tracking-wider">Real-time Monitoring</p>
        
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Latitude</span>
            <span className="font-mono text-sm bg-gray-200/50 px-2 py-1 rounded">{markerPosition.lat.toFixed(6)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">Longitude</span>
            <span className="font-mono text-sm bg-gray-200/50 px-2 py-1 rounded">{markerPosition.lng.toFixed(6)}</span>
          </div>
          
          <div className={`mt-4 p-3 rounded-xl flex items-center justify-center gap-2 font-bold transition-all bg-white/50 border border-gray-200 shadow-sm`}>
            {/* Dot Indicator */}
            <span className={`flex h-3 w-3 relative`}>
              {statusInfo.pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${statusInfo.color}`}></span>}
              <span className={`relative inline-flex rounded-full h-3 w-3 ${statusInfo.color}`}></span>
            </span>
            {/* Text Label */}
            <span className="text-sm text-gray-800">{statusInfo.label}</span>
          </div>

          <div className="text-xs text-gray-500 mt-2 text-center">
            *คลิกบนแผนที่เพื่อย้ายจุด Safe Zone
          </div>

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
                
                if (!error) {
                    alert("บันทึกจุดปลอดภัยเรียบร้อย!");
                } else {
                    alert("เกิดข้อผิดพลาด: " + error.message);
                }
            }}
            className="w-full mt-4 bg-white/20 hover:bg-white/30 text-white text-sm font-semibold py-2 px-4 rounded-lg border border-white/30 transition-all active:scale-95"
          >
            บันทึกตำแหน่งนี้ (Save Config)
          </button>

          <button 
            onClick={() => {
                // ถ้ายังไม่ได้ตำแหน่ง Admin ให้ใช้ Safe Zone แทน หรือแจ้งเตือน
                const originLat = adminLocation ? adminLocation.lat : safeZoneCenter.lat;
                const originLng = adminLocation ? adminLocation.lng : safeZoneCenter.lng;

                const url = `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLng}&destination=${markerPosition.lat},${markerPosition.lng}&travelmode=driving`;
                window.open(url, '_blank');
            }}
            className="w-full mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-lg shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <span>เปิดการนำทาง Google Maps</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </button>
        </div>
      </div>

      <GoogleMap
        mapContainerStyle={containerStyle}
        center={defaultCenter} // ใช้ center เริ่มต้น (map.panTo จะคุมต่อ)
        zoom={16}
        onLoad={onLoad}
        onUnmount={onUnmount}
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
        <Marker 
            position={markerPosition} 
            animation={google.maps.Animation.DROP}
            label="Patient"
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
