'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { GoogleMap, useJsApiLoader, Marker, Circle, DirectionsRenderer, OverlayView, TrafficLayer } from '@react-google-maps/api'
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

  // Map Options - Switch to Hybrid (Satellite) when Navigating
  // Moved up to avoid "Order of Hooks" error
  const mapOptions = useMemo<google.maps.MapOptions>(() => ({
    disableDefaultUI: true, // ซ่อน UI เดิมของ Google Maps ทั้งหมด
    clickableIcons: false,
    scrollwheel: true,
    mapTypeId: isNavigating ? 'hybrid' : 'roadmap', // เปลี่ยนเป็นดาวเทียมเมื่อนำทาง
    tilt: isNavigating ? 45 : 0,
    heading: isNavigating ? adminHeading : 0,
  }), [isNavigating, adminHeading]);
  
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

  // State สำหรับรับข้อมูล Route Steps (Turn-by-Turn)
  const [routeSteps, setRouteSteps] = useState<google.maps.DirectionsStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [distToNextStep, setDistToNextStep] = useState(0); // ระยะทางถึงจุดเลี้ยวถัดไป

  // คำนวณเส้นทาง และเก็บ Steps
  const calculateRoute = (origin: google.maps.LatLngLiteral, destination: google.maps.LatLngLiteral) => {
    if (!window.google) return;
    const directionsService = new google.maps.DirectionsService();
    directionsService.route(
      {
        origin: origin,      
        destination: destination, 
        travelMode: google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: true, // [เป๊ะ 1] ให้ Google เสนอเส้นทางสำรองเหมือนในแอปจริง
        optimizeWaypoints: true,
        drivingOptions: {
          departureTime: new Date(Date.now()), // คำนวณตามสภาพจราจรปัจจุบัน
          trafficModel: 'bestguess' as google.maps.TrafficModel // ใช้ cast เพื่อป้องกัน Type error
        }
      },
      (result, status) => {
        if (status === "OK" && result) {
          setDirectionsResponse(result);
          // เก็บข้อมูล Steps เพื่อทำ Navigation HUD
          const leg = result.routes[0].legs[0];
          setRouteSteps(leg.steps); 
          setCurrentStepIndex(0); // เริ่มต้นที่ Step แรก
        } else {
          console.error(`Directions request failed due to ${status}`);
        }
      }
    );
  };

  // Logic การเปลี่ยน Step นำทาง (Turn-by-Turn Logic)
  useEffect(() => {
    if (isNavigating && routeSteps.length > 0 && adminLocation && currentStepIndex < routeSteps.length) {
        const currentStep = routeSteps[currentStepIndex];
        // คำนวณระยะห่างปัจจุบัน ถึง จุดสิ้นสุดของ Step นี้ (จุดเลี้ยว)
        const dist = getDistanceFromLatLonInM(
            adminLocation.lat, adminLocation.lng, 
            currentStep.end_location.lat(), currentStep.end_location.lng()
        );
        setDistToNextStep(dist);

        // ถ้าใกล้ถึงจุดเลี้ยว (น้อยกว่า 30 เมตร) ให้ข้ามไป Step ถัดไป
        if (dist < 30) {
            if (currentStepIndex < routeSteps.length - 1) {
                setCurrentStepIndex(prev => prev + 1);
            }
        }
    }
  }, [adminLocation, isNavigating, routeSteps, currentStepIndex]);

  // ฟังก์ชันคำนวณระยะทาง
  // const getDistanceFromLatLonInM = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  //   const R = 6371; 
  //   const dLat = deg2rad(lat2 - lat1);
  //   const dLon = deg2rad(lon2 - lon1);
  //   const a =
  //     Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  //     Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
  //     Math.sin(dLon / 2) * Math.sin(dLon / 2);
  //   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  //   const d = R * c; 
  //   return d * 1000; 
  // }

  // const deg2rad = (deg: number) => {
  //   return deg * (Math.PI / 180)
  // }

  // คำนวณเส้นทาง
  // const calculateRoute = (origin: google.maps.LatLngLiteral, destination: google.maps.LatLngLiteral) => {
  //   if (!window.google) return;
  //   const directionsService = new google.maps.DirectionsService();
  //   directionsService.route(
  //     {
  //       origin: origin,      
  //       destination: destination, 
  //       travelMode: google.maps.TravelMode.DRIVING,
  //     },
  //     (result, status) => {
  //       if (status === "OK" && result) {
  //         setDirectionsResponse(result); 
  //       } else {
  //         console.error(`Directions request failed due to ${status}`);
  //       }
  //     }
  //   );
  // };

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

  // Helper: Strip HTML tags from instruction
  const stripHtml = (html: string) => {
    const tmp = document.createElement("DIV");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  }

  // Helper: Get Icon for Maneuver
  const getManeuverIcon = (maneuver: string | undefined) => {
    if (!maneuver) return (
       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-10 h-10">
         <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
       </svg>
    ); // Straight default
    
    if (maneuver.includes("left")) return (
       <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-10 h-10">
         <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
       </svg>
    );
    if (maneuver.includes("right")) return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-10 h-10">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l6-6m0 0l-6-6m6 6H9a6 6 0 000 12h3" />
        </svg>
    );
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-10 h-10">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
        </svg>
    );
  }



  return (
    <div className="relative w-full h-screen bg-gray-100 font-sans">

      {/* --- HUD: Navigation Mode (Google Maps Clone 100%) --- */}
      {isNavigating ? (
        <>
            {/* 1. Top Green Banner (Direction) */}
            <div className="fixed top-2 left-2 right-2 z-[1100] bg-[#006747] text-white p-4 rounded-xl shadow-lg flex items-center justify-between min-h-[100px]">
                <div className="flex items-center gap-4 overflow-hidden">
                    {/* Direction Icon */}
                    <div className="flex-shrink-0 opacity-90">
                        {routeSteps.length > 0 ? getManeuverIcon(routeSteps[currentStepIndex]?.maneuver) : (
                             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-12 h-12">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                             </svg>
                        )}
                    </div>
                    {/* Text Info */}
                    <div className="flex-1 min-w-0">
                        <div className="text-2xl font-bold truncate">
                             {routeSteps.length > 0 && routeSteps[currentStepIndex] 
                                ? stripHtml(routeSteps[currentStepIndex].instructions) 
                                : "มุ่งหน้าไปทางทิศเหนือ"}
                        </div>
                        {/* Distance to Turn (Optional Subtext if needed) */}
                         <div className="text-lg opacity-80">
                             อีก {distToNextStep < 1000 ? `${distToNextStep.toFixed(0)} ม.` : `${(distToNextStep/1000).toFixed(1)} กม.`}
                        </div>
                    </div>
                </div>
                
                {/* Assistant Icon (Right) */}
                <div className="flex-shrink-0 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md ml-2">
                    <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none">
                        <path d="M6 12C6 15.3137 8.68629 18 12 18C14.6124 18 16.8349 16.3304 17.6586 14" stroke="#4285F4" strokeWidth="2.5" strokeLinecap="round"/>
                        <path d="M17.6586 14C17.8809 13.3668 18 12.6953 18 12C18 8.68629 15.3137 6 12 6C9.28188 6 6.97448 7.80806 6.1969 10.3" stroke="#EA4335" strokeWidth="2.5" strokeLinecap="round"/>
                        <path d="M6.1969 10.3C6.06822 10.8465 6 11.4162 6 12" stroke="#FBBC05" strokeWidth="2.5" strokeLinecap="round"/>
                        <path d="M12 12L12 12.01" stroke="#34A853" strokeWidth="3" strokeLinecap="round"/>
                    </svg>
                </div>
            </div>

            {/* 2. Right Floating Buttons (Black Circles) */}
            <div className="fixed right-4 top-[140px] z-[1000] flex flex-col gap-3">
                 {/* Compass */}
                 <button className="w-10 h-10 bg-[#202124] rounded-full flex items-center justify-center shadow-lg text-white/90">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-red-500">
                        <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                    </svg>
                 </button>
                 {/* Search */}
                 <button className="w-10 h-10 bg-[#202124] rounded-full flex items-center justify-center shadow-lg text-white">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 001.758 1.758z" />
                    </svg>
                 </button>
                 {/* Mute */}
                 <button className="w-10 h-10 bg-[#202124] rounded-full flex items-center justify-center shadow-lg text-white">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                       <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                    </svg>
                 </button>
                 {/* Alert */}
                 <button className="w-10 h-10 bg-[#202124] rounded-full flex items-center justify-center shadow-lg text-white">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                       <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                 </button>
            </div>

            {/* 3. "Re-center" Button (Bottom Left) */}
            <div className="fixed left-4 bottom-36 z-[1000]">
                 <button 
                    onClick={() => {
                        if (adminLocation && map) {
                            map.panTo(adminLocation);
                            map.setZoom(20);
                            map.setHeading(adminHeading);
                        }
                    }}
                    className="bg-[#202124] text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-medium"
                 >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-white">
                        <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                    </svg>
                    ปรับจุดกลาง
                 </button>
            </div>

            {/* 4. Bottom Dark Panel */}
            <div className="fixed bottom-0 left-0 right-0 z-[1100] bg-[#202124] text-white p-4 pb-8 rounded-t-2xl shadow-2xl border-t border-gray-800">
                {/* Drag Handle */}
                <div className="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>

                <div className="flex items-center justify-between">
                    {/* Time & Distance Info */}
                    <div>
                         <div className="flex items-baseline gap-2">
                             <span className="text-3xl font-bold font-sans text-white">
                                {((currentDistance/1000) * 2).toFixed(0)} นาที
                             </span>
                             {/* Leaf Icon */}
                             <svg viewBox="0 0 24 24" className="w-5 h-5 text-green-500 fill-current mb-1">
                                <path d="M12 2C7.5 2 3.5 5.5 3.5 10c0 6.5 8.5 12 8.5 12s8.5-5.5 8.5-12c0-4.5-4-8-8.5-8zm0 15c-1.5-3-4-5-4-8 0-2.5 2-4 4-4s4 1.5 4 4c0 3-2.5 5-4 8z" />
                                <path d="M12 6c-2 0-3.5 1.5-3.5 3.5S10 13 12 13s3.5-1.5 3.5-3.5S14 6 12 6z" fillOpacity="0.3"/>
                             </svg>
                         </div>
                         <div className="text-gray-400 text-base flex items-center gap-1 font-medium">
                            <span>{(currentDistance/1000).toFixed(1)} กม.</span>
                            <span>•</span>
                            <span>{new Date(Date.now() + (currentDistance/1000)*2*60000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                         </div>
                    </div>

                    {/* Controls: Route & Exit */}
                    <div className="flex items-center gap-3">
                        {/* Route Option Button */}
                        <button className="w-12 h-12 rounded-full bg-[#303134] flex items-center justify-center">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-white">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                            </svg>
                        </button>
                        
                        {/* Exit Button */}
                        <button 
                            onClick={() => setIsNavigating(false)}
                            className="bg-[#D93025] hover:bg-[#d93025]/90 text-white px-6 py-3 rounded-full font-bold text-lg shadow-md min-w-[100px]"
                        >
                            ออก
                        </button>
                    </div>
                </div>
            </div>
        </>
      ) : (
        /* --- Standard Monitor UI (Hidden when Navigating) --- */
        <>
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
          <div className="fixed right-4 bottom-[380px] md:bottom-8 z-[1000] flex flex-col gap-3">
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
          <div className="fixed bottom-0 left-0 right-0 z-[1000] bg-white rounded-t-3xl shadow-[0_-5px_20px_rgba(0,0,0,0.1)] p-6 pb-12 md:w-96 md:rounded-2xl md:bottom-6 md:left-6 md:right-auto md:pb-6 transition-all transform duration-300 ease-out">
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
            {/* External App Link */}
            <button 
                onClick={() => {
                    const originLat = adminLocation ? adminLocation.lat : safeZoneCenter.lat;
                    const originLng = adminLocation ? adminLocation.lng : safeZoneCenter.lng;
                    const url = `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLng}&destination=${markerPosition.lat},${markerPosition.lng}&travelmode=driving`;
                    window.open(url, '_blank');
                }}
                className="mt-3 w-full bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold py-3 rounded-xl shadow-sm transition flex items-center justify-center gap-2 border border-blue-200"
            >
                <span>เปิดการนำทางเต็มรูปแบบ</span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
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
        </>
      )}

      <GoogleMap
        mapContainerStyle={containerStyle}
        center={isNavigating && adminLocation ? adminLocation : markerPosition}
        zoom={isNavigating ? 18 : 16}
        onLoad={onLoad}
        onUnmount={onUnmount}
        options={mapOptions}
        onClick={(e) => {
            if (e.latLng && !isNavigating) {
                setSafeZoneCenter({ lat: e.latLng.lat(), lng: e.latLng.lng() });
            }
        }}
        onDragStart={() => {
            if (isAutoCenter) setIsAutoCenter(false);
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

        {/* เส้นทางนำทาง (Directions Path) */}
        {directionsResponse && (
          <DirectionsRenderer 
            directions={directionsResponse} 
            options={{
              polylineOptions: {
                strokeColor: "#4285F4", // สีฟ้า Google Maps
                strokeWeight: 6,
                strokeOpacity: 0.8,
              },
              // [เป๊ะ 2] ปิด Marker เริ่มต้นของ Google เพื่อใช้ Marker รูปคน/Blue Dot ที่เราทำไว้เอง
              suppressMarkers: true, 
              preserveViewport: true // กันไม่ให้ map ย่อขยายเองตอนเปลี่ยนเส้นทาง (เราคุมเองแล้ว)
            }}
          />
        )}



      </GoogleMap>

       {/* Debug: ข้อมูลเส้นทางแบบละเอียด (ตาม Request) */}
       {directionsResponse && (
        <div className="absolute top-28 left-4 z-[1050] bg-white p-4 rounded-lg shadow-xl border-t-4 border-blue-500 hidden md:block max-w-sm">
            <h3 className="font-bold text-lg mb-2">ข้อมูลการนำทาง (Debug)</h3>
            <div className="space-y-1 text-sm">
                <p>ระยะทาง: <span className="font-mono font-bold text-gray-700">{directionsResponse.routes[0].legs[0].distance?.text}</span></p>
                <p>เวลาเดินทาง: <span className="text-green-600 font-bold">{directionsResponse.routes[0].legs[0].duration?.text}</span></p>
                <p className="text-gray-500">ผ่าน: {directionsResponse.routes[0].summary}</p>
            </div>
        </div>
      )}
    </div>
  )
}
