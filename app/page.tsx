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
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
    language: 'th', // บังคับภาษาไทย
    region: 'TH'
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

  // State สำหรับเสียง (Mute)
  const [isMuted, setIsMuted] = useState(false)

  // Map Options - Switch to Hybrid (Satellite) when Navigating
  // Moved up to avoid "Order of Hooks" error
  const mapOptions = useMemo<google.maps.MapOptions>(() => ({
    disableDefaultUI: true, // ซ่อน UI เดิมของ Google Maps ทั้งหมดแบบเหมา
    clickableIcons: false,
    scrollwheel: true,
    mapTypeId: isNavigating ? 'hybrid' : 'roadmap', // เปลี่ยนเป็นดาวเทียมเมื่อนำทาง
    tilt: isNavigating ? 45 : 0,
    heading: isNavigating ? adminHeading : 0,
    // Explicitly hide controls to prevent "N" compass overlap
    zoomControl: false,
    mapTypeControl: false,
    streetViewControl: false, 
    rotateControl: false, 
    fullscreenControl: false,
    mapId: "90f87356969d889c", // Vector Map Demo ID
    gestureHandling: "greedy",
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
    // ทำงานเฉพาะเมื่อกำลังนำทาง (Navigating) + มีตำแหน่ง Admin + และเปิด Auto Center อยู่
    if (isNavigating && adminLocation && map && isAutoCenter) {
        // 1. ย้ายกล้องไปหา Admin (ตัวคุณ)
        map.panTo(adminLocation);
        
        // 2. ปรับมุมกล้องให้เหมือน GPS
        map.setZoom(20); // Zoom ใกล้สุด
        map.setTilt(45); // เอียง 3D
        map.setHeading(adminHeading); // หมุนตามเข็มทิศ
        
        // 3. (ลบ logic เก่าที่ปิด auto-center อัตโนมัติทิ้งไป เพราะตอนนี้เราต้องการให้มัน open จนกว่าจะ drag)
    }
  }, [isNavigating, adminLocation, adminHeading, map, isAutoCenter]); // เพิ่ม isAutoCenter ใน dependency

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

  // State สำหรับโหมดจำลอง (Simulation Mode)
  const [isSimulating, setIsSimulating] = useState(false)
  const simulationInterval = useRef<NodeJS.Timeout | null>(null)

  // Simulation Logic
  useEffect(() => {
    if (isSimulating && directionsResponse) {
        // 1. Flatten all path points
        const allPoints: google.maps.LatLng[] = [];
        const legs = directionsResponse.routes[0].legs;
        legs.forEach(leg => {
            leg.steps.forEach(step => {
                // step.path is array of LatLng
                step.path.forEach(p => allPoints.push(p));
            });
        });

        // 2. Start Interval
        let i = 0;
        // Find nearest point index to start (optional, simplistic start from 0 for now)
        // Or start from where we are? For demo, start from 0 is fine or continue.
        
        setIsNavigating(true); // Auto start nav
        if (isAutoCenter) setIsAutoCenter(false);

        simulationInterval.current = setInterval(() => {
            if (i >= allPoints.length) {
                setIsSimulating(false);
                return;
            }
            const p = allPoints[i];
            const newPos = { lat: p.lat(), lng: p.lng() };
            
            // Update Admin Location
            setAdminLocation(newPos);
            
            // Calculate Heading (simplistic)
            if (i < allPoints.length - 1) {
                const nextP = allPoints[i+1];
                const heading = google.maps.geometry.spherical.computeHeading(p, nextP);
                setAdminHeading(heading);
            }

            i += 1; // Speed multiplier (skip points for speed if needed)
        }, 100); // 100ms update rate

    } else {
        // Stop Simulation
        if (simulationInterval.current) {
            clearInterval(simulationInterval.current);
            simulationInterval.current = null;
        }
    }

    return () => {
        if (simulationInterval.current) clearInterval(simulationInterval.current);
    }
  }, [isSimulating, directionsResponse]);

  // Ref สำหรับเก็บตำแหน่งผู้ป่วยก่อนหน้า (เพื่อคำนวณทิศทาง)
  const prevMarkerPosRef = useRef<google.maps.LatLngLiteral | null>(null);

  // Helper: คำนวณทิศทาง (Heading) จากจุด A ไป B
  const calculateHeading = (p1: google.maps.LatLngLiteral, p2: google.maps.LatLngLiteral) => {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const toDeg = (rad: number) => (rad * 180) / Math.PI;

    const lat1 = toRad(p1.lat);
    const lat2 = toRad(p2.lat);
    const dLng = toRad(p2.lng - p1.lng);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  };

  // Helper: ฟังก์ชันติดตามผู้ป่วย (Camera Following) - ปรับมุมมองนำทางเป๊ะๆ
  const followPatient = (newPos: google.maps.LatLngLiteral, heading: number) => {
    if (map) {
      map.moveCamera({
        center: newPos,
        heading: heading, // หมุนหน้าแผนที่ไปตามทิศที่เดินจริง
        tilt: 55,         // ปรับมุมก้มให้เป็น 3D (เป๊ะตามรูป Reference)
        zoom: 19          // ซูมระดับเห็นพื้นถนนชัดเจน
      });
    }
  };

  // Helper: คำนวณระยะทางระหว่างจุด 2 จุด (หน่วย: เมตร)
  const getDistanceMeters = (p1: google.maps.LatLngLiteral, p2: google.maps.LatLngLiteral) => {
    const R = 6371e3; // รัศมีโลก (เมตร)
    const toRad = (d: number) => d * Math.PI / 180;
    const lat1 = toRad(p1.lat);
    const lat2 = toRad(p2.lat);
    const dLat = toRad(p2.lat - p1.lat);
    const dLng = toRad(p2.lng - p1.lng);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // อัปเดตตำแหน่ง Marker (Patient) - ปรับปรุงใหม่ให้เสถียร (Smooth & Stable)
  const updateMarkerPosition = (lat: number, lng: number) => {
    const newPos = { lat, lng };
    const prevPos = prevMarkerPosRef.current;
    
    // 1. Noise Filter: เช็คระยะทางก่อนว่าควรขยับไหม?
    let dist = 0;
    let heading = 0;
    
    if (prevPos) {
        dist = getDistanceMeters(prevPos, newPos);
        
        // ถ้าขยับน้อยกว่า 2 เมตร ถือว่าเป็น GPS Noise -> ไม่ทำอะไรเลย (นิ่งๆ ไว้)
        if (dist < 2) return;

        // คำนวณ Heading
        if (prevPos.lat !== newPos.lat || prevPos.lng !== newPos.lng) {
            heading = calculateHeading(prevPos, newPos);
        }
    }

    setMarkerPosition(newPos);
    
    // บันทึกตำแหน่งเก่า
    prevMarkerPosRef.current = newPos; 
    
    localStorage.setItem('lastPatientLat', lat.toString());
    localStorage.setItem('lastPatientLng', lng.toString());
    
    // 2. Smart Camera Follow: กล้องจะตามก็ต่อเมื่อขยับเยอะพอสมควร หรือ Heading เปลี่ยนชัดเจน
    // ช่วยลดอาการ "เด้งไปเด้งมา" (Jitter)
    if (isAutoCenter && !isNavigating) {
       // ขยับกล้องก็ต่อเมื่อระยะทาง > 5 เมตร หรือเพิ่งเริ่ม (ไม่มี prevPos)
       if (!prevPos || dist > 5) {
            followPatient(newPos, heading || (map ? map.getHeading() || 0 : 0));
       } 
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

  // Helper: Strip HTML tags from instruction
  const stripHtml = (html: string) => {
    if (typeof window === 'undefined') return html; 
    const tmp = document.createElement("DIV");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  }

  // --- TTS Logic (Text-to-Speech) ---
  const speak = (text: string) => {
    if (isMuted || typeof window === 'undefined') return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'th-TH'; 
    window.speechSynthesis.speak(utterance);
  };

  // Speak when instruction changes
  useEffect(() => {
    if (isNavigating && routeSteps.length > 0 && routeSteps[currentStepIndex]) {
        const text = stripHtml(routeSteps[currentStepIndex].instructions);
        speak(text);
    }
  }, [currentStepIndex, isNavigating, routeSteps]); // stripHtml is stable/const

  // Speak welcome message
  useEffect(() => {
    if (isNavigating) {
        speak("เริ่มนำทาง");
    } else {
        window.speechSynthesis.cancel(); 
    }
  }, [isNavigating]);

  if (loadError) return <div className="p-10 text-red-500">Error loading maps. Check API Key.</div>;
  if (!isLoaded) return <div className="p-10">Loading Map...</div>;

  // Helper for text color
  const distanceColor = (d: number) => {
    if (d > SAFE_ZONE_DANGER) return 'text-red-600';
    if (d > SAFE_ZONE_WARNING) return 'text-yellow-600';
    return 'text-green-600';
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

      {/* --- HUD: Driver Mode (Navigation - Google Maps Clone) --- */}
      {isNavigating ? (
        <>
            {/* 1. Top Green Banner (Current Instruction + Next Step) - Compact Version */}
            <div className="fixed top-2 left-2 right-2 z-[1100] flex flex-col gap-1 items-start max-w-lg mx-auto w-full">
                {/* Main Instruction Card */}
                <div className="bg-[#006747] text-white p-3 rounded-lg shadow-lg flex items-center justify-between min-h-[80px] w-full relative overflow-hidden">
                    <div className="flex items-center gap-3 w-full">
                        {/* Turn Icon & Distance (Left Cluster) */}
                        <div className="flex flex-col items-center justify-center min-w-[60px]">
                             <div className="mb-0.5 transform scale-90">
                                {routeSteps.length > 0 ? getManeuverIcon(routeSteps[currentStepIndex]?.maneuver) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-8 h-8">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                                    </svg>
                                )}
                             </div>
                             <div className="text-lg font-bold font-sans tracking-tight leading-none">
                                {distToNextStep < 1000 ? `${distToNextStep.toFixed(0)} ม.` : `${(distToNextStep/1000).toFixed(1)} กม.`}
                             </div>
                        </div>
                        {/* Text Instruction (Compact) */}
                        <div className="flex-1 border-l border-white/20 pl-3 min-h-[50px] flex items-center">
                            <h2 className="text-xl font-bold leading-snug tracking-tight line-clamp-2">
                                 {routeSteps.length > 0 && routeSteps[currentStepIndex] 
                                    ? stripHtml(routeSteps[currentStepIndex].instructions) 
                                    : "ขับตามเส้นทาง"}
                            </h2>
                        </div>
                    </div>
                </div>

                {/* Secondary 'Then' Step (Small Green Box below) */}
                {routeSteps.length > currentStepIndex + 1 && (
                    <div className="bg-[#004D35] text-white/90 px-3 py-1.5 rounded-md shadow-md flex items-center gap-2 animate-slide-in-down ml-1 mt-0.5">
                        <span className="text-xs font-medium opacity-80">แล้ว</span>
                        <div className="transform scale-75 origin-center">
                            {getManeuverIcon(routeSteps[currentStepIndex + 1]?.maneuver)}
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 transform rotate-180 opacity-60">
                             <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                        </svg>
                    </div>
                )}
            </div>

            {/* 2. Floating Buttons (Right Side - Only Mute) */}
            <div className="fixed right-4 top-[160px] z-[1000] flex flex-col gap-3">
                 {/* Mute Button Only */}
                 <button 
                    onClick={() => setIsMuted(!isMuted)} 
                    className="w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-lg text-gray-700 active:scale-95 transition-transform"
                 >
                    {isMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-gray-400">
                           <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                        </svg>
                    )}
                 </button>
            </div>

            {/* 4. "Re-center" Button (Bottom Left) - Google Style */}
            <div className="fixed left-4 bottom-48 z-[1000]">
                 {!isAutoCenter && (
                     <button 
                        onClick={() => {
                            setIsAutoCenter(true); 
                            // Advance Recenter: Focus Patient using helper
                            if (map && markerPosition) {
                                followPatient(markerPosition, map.getHeading() || 0);
                            }
                        }}
                        className="bg-white text-[#1A73E8] px-5 py-2.5 rounded-full shadow-lg flex items-center gap-2 text-base font-bold border border-gray-100 animate-fade-in-up"
                     >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                             <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                        </svg>
                        ปรับจุดกลาง
                     </button>
                 )}
            </div>

            {/* 5. Bottom Info Panel (Google Maps Style: White - Compact) */}
            <div className="fixed bottom-0 left-0 right-0 z-[1100] bg-white text-gray-900 p-4 pb-6 rounded-t-2xl shadow-[0_-5px_30px_rgba(0,0,0,0.15)]">
                {/* Drag Handle */}
                <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-3"></div>

                <div className="flex items-center justify-between px-1">
                    {/* Left: Time & Distance */}
                    <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-2">
                             {/* Duration (Green & Compact) */}
                             <span className="text-4xl font-bold text-[#188038] tracking-tight font-sans text-shadow-sm">
                                {directionsResponse?.routes[0]?.legs[0]?.duration?.value 
                                    ? Math.ceil(directionsResponse.routes[0].legs[0].duration.value / 60) 
                                    : 0} <span className="text-xl font-semibold text-gray-600">นาที</span>
                             </span>
                        </div>
                        
                        <div className="flex items-center gap-2 text-base text-gray-500 font-medium">
                             {/* Distance */}
                             <span>
                                {directionsResponse?.routes[0]?.legs[0]?.distance?.text || '0 กม.'}
                             </span>
                             <span className="text-gray-300">•</span>
                             {/* ETA Time (Mockup logic) */}
                             <span>
                                {directionsResponse?.routes[0]?.legs[0]?.duration?.value 
                                    ? new Date(Date.now() + directionsResponse.routes[0].legs[0].duration.value * 1000).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
                                    : '--:--'} น.
                             </span>
                        </div>
                    </div>

                    {/* Right: Exit Button (Compact) */}
                    <div className="flex items-center gap-3">
                        <button 
                            onClick={() => setIsNavigating(false)}
                            className="bg-[#D93025] hover:bg-[#B31412] text-white px-6 py-2 rounded-full font-bold text-base shadow-md transition-colors border border-transparent active:scale-95 min-w-[80px]"
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

          {/* 2. Floating Map Controls (Re-center Button for Standard Mode) */}
          <div className="fixed left-4 bottom-32 md:bottom-32 z-[1000]">
             {!isAutoCenter && (
                 <button 
                    onClick={() => {
                        setIsAutoCenter(true);
                        if (map) {
                            // Focus back to relevant point (Patient or Admin)
                            const target = markerPosition || adminLocation;
                            if (target) {
                                map.panTo(target);
                                map.setZoom(16);
                            }
                        }
                    }}
                    className="bg-white text-[#1A73E8] px-5 py-2.5 rounded-full shadow-lg flex items-center gap-2 text-base font-bold border border-gray-100 animate-fade-in-up"
                 >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                         <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                    </svg>
                    ปรับจุดกลาง
                 </button>
             )}
          </div>

          {/* 3. Bottom Sheet Info Card */}
          <div className="fixed bottom-0 left-0 right-0 z-[1000] bg-white rounded-t-3xl shadow-[0_-5px_20px_rgba(0,0,0,0.15)] pb-6 md:w-96 md:rounded-2xl md:bottom-6 md:left-6 md:right-auto md:pb-6 transition-transform duration-300 ease-out transform translate-y-0">
            {/* Handle for drag indicator */}
            <div className="w-12 h-1.5 bg-gray-300 rounded-full mx-auto mt-3 mb-2 md:hidden"></div>

            <div className="px-6 pt-2">
                {/* Header: Title & Distance */}
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900">ผู้ป่วย</h2>
                        <div className="flex items-center gap-1 text-gray-500 text-sm mt-0.5">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-gray-400">
                                    <path fillRule="evenodd" d="M11.54 22.351l.07.04.028.016a.76.76 0 00.723 0l.028-.015.071-.041a16.975 16.975 0 001.144-.742 19.58 19.58 0 002.683-2.282c1.944-1.99 3.963-4.98 3.963-8.827a8.25 8.25 0 00-16.5 0c0 3.846 2.02 6.837 3.963 8.827a19.58 19.58 0 002.682 2.282 16.975 16.975 0 001.145.742zM12 13.5a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                            </svg>
                            <span>{markerPosition ? `${markerPosition.lat.toFixed(5)}, ${markerPosition.lng.toFixed(5)}` : 'กำลังค้นหา...'}</span>
                        </div>
                    </div>
                    <div className="text-right">
                        <span className="block text-xs text-gray-500 font-medium mb-0.5">ระยะห่าง</span>
                        {/* Check distance validity */}
                        {currentDistance > 10000 ? (
                             <span className="text-xl font-bold text-gray-400">รอพิกัด</span>
                        ) : (
                             <span className={`text-2xl font-bold ${distanceColor(currentDistance)} font-sans`}>
                                {currentDistance < 1000 ? currentDistance.toFixed(0) : (currentDistance/1000).toFixed(2)} 
                                <span className="text-base font-normal text-gray-500 ml-1">{currentDistance < 1000 ? 'ม.' : 'กม.'}</span>
                             </span>
                        )}
                    </div>
                </div>

                {/* Actions Grid */}
                <div className="grid grid-cols-1 gap-3">
                    {/* Primary Button: Start Navigation */}
                    <button 
                         onClick={() => {
                            if (!adminLocation) {
                                alert("กำลังระบุตำแหน่งของคุณ... กรุณารอสักครู่");
                                return;
                            }
                            if (directionsResponse) {
                                setIsNavigating(true);
                                if(map) {
                                    map.setZoom(20);
                                    map.setTilt(45);
                                }
                            } else {
                                // Force calculate if missing
                                const origin = adminLocation || safeZoneCenter; 
                                calculateRoute(origin, markerPosition);
                                setTimeout(() => setIsNavigating(true), 1500); // Wait for calc
                            }
                        }}
                        className="bg-[#1A73E8] hover:bg-[#1557B0] text-white py-3 px-6 rounded-full font-bold text-lg shadow-md flex items-center justify-center gap-2 w-full transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                            <path fillRule="evenodd" d="M8.161 2.58a.75.75 0 01.109-.747L9.56 1.108a.75.75 0 011.088-.043l3.528 3.528a.75.75 0 001.06 0l3.529-3.528a.75.75 0 011.087.043l1.29 1.48a.75.75 0 01-.109.748L5.688 17.65a.75.75 0 01-1.127.069L.226 13.385a.75.75 0 01.077-1.139l1.48-1.29a.75.75 0 01.748-.109l6.39 3.197L8.161 2.58z" clipRule="evenodd" />
                            <path d="M12.5 15a.5.5 0 01.5-.5h4a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5h-4a.5.5 0 01-.5-.5V15z" />
                        </svg>
                        เริ่มนำเส้นทาง
                    </button>

                    {/* Secondary Button: Open in Google Maps App */}
                    <a 
                        href={`https://www.google.com/maps/dir/?api=1&destination=${markerPosition?.lat},${markerPosition?.lng}&travelmode=driving`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bg-[#E8F0FE] text-[#1967D2] py-3 px-6 rounded-full font-bold text-lg flex items-center justify-center gap-2 w-full transition-colors border border-transparent hover:border-[#1967D2]/20"
                    >
                        เปิดใน Google Maps 
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                    </a>
                </div>
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
            // animation={window.google?.maps?.Animation?.DROP} // เอาออกเพื่อให้ขยับสมูท ไม่เด้งลงมาจากฟ้าทุกครั้ง
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
                strokeColor: "#2977F5", // ฟ้าสด Google Maps
                strokeWeight: 8,        // เส้นหนาชัดเจน
                strokeOpacity: 0.9,     // เกือบทึบ
                icons: [{
                    icon: {
                        // @ts-ignore
                        path: window.google?.maps?.SymbolPath?.FORWARD_CLOSED_ARROW,
                        scale: 2.5,          // ขนาดลูกศร
                        strokeColor: '#ffffff', // สีขาว
                        strokeWeight: 1,
                        fillColor: '#ffffff',
                        fillOpacity: 1
                    },
                    offset: '0',
                    repeat: '70px' // ระยะห่างระหว่างลูกศร
                }]
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
