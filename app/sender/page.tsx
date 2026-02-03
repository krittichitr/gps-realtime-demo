'use client'
import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export default function Sender() {
  const [status, setStatus] = useState('รอเริ่มส่งพิกัด...')
  const [statusColor, setStatusColor] = useState('text-gray-500')
  const [distance, setDistance] = useState<number | null>(null)
  const [homePos, setHomePos] = useState({ lat: 13.7649, lng: 100.5383 }) // Default fallback

  // Wake Lock & Audio Ref for Background Execution
  const wakeLock = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // ฟังก์ชันขอ Screen Wake Lock (ป้องกันหน้าจอดับ)
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLock.current = await (navigator as any).wakeLock.request('screen');
        console.log('Wake Lock active!');
        
        wakeLock.current.addEventListener('release', () => {
          console.log('Wake Lock released');
        });
      }
    } catch (err: any) {
      console.error(`${err.name}, ${err.message}`);
    }
  };

  // Re-acquire lock when visibility changes
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (wakeLock.current !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLock.current) wakeLock.current.release();
    };
  }, []);

  // ฟังก์ชันคำนวณระยะห่าง (หน่วยเป็นเมตร)
  function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371e3; // รัศมีโลก (เมตร)
    const p1 = lat1 * Math.PI/180;
    const p2 = lat2 * Math.PI/180;
    const dp = (lat2-lat1) * Math.PI/180;
    const dl = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(dp/2) * Math.sin(dp/2) +
              Math.cos(p1) * Math.cos(p2) *
              Math.sin(dl/2) * Math.sin(dl/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; 
  }

  // การนำไปใช้เช็คสถานะ
  function checkGeofence(currentLat: number, currentLng: number, centerLat: number, centerLng: number) {
    const d = calculateDistance(currentLat, currentLng, centerLat, centerLng);
    setDistance(d);
    
    if (d > 50) {
        setStatus("สถานะ: อันตราย! ออกนอกรัศมี 50ม.");
        setStatusColor("text-red-600");
    } else if (d > 20) {
        setStatus("สถานะ: เตือน! ออกนอกรัศมี 20ม.");
        setStatusColor("text-orange-500");
    } else {
        setStatus("สถานะ: ปลอดภัย");
        setStatusColor("text-green-600");
    }
  }

  // Ref for throttling updates
  const lastSentRef = useRef<number>(0);

  // ... (existing code)

  const sendLocation = async () => {
    // 1. Activate Keep-Alive Mechanisms
    await requestWakeLock();
    if (audioRef.current) {
        audioRef.current.play().catch(e => console.log("Audio play failed:", e));
    }

    if ("geolocation" in navigator) {
      setStatus("กำลังระบุจุดเริ่มต้น (Safe Zone)...");
      
      // 2. หาตำแหน่งปัจจุบันเพื่อตั้งเป็นจุดปลอดภัย (Safe Zone Center)
      navigator.geolocation.getCurrentPosition((startPos) => {
        const startLat = startPos.coords.latitude;
        const startLng = startPos.coords.longitude;
        
        setHomePos({ lat: startLat, lng: startLng });
        setStatus(`ตั้งจุดปลอดภัยแล้ว (${startLat.toFixed(4)}, ${startLng.toFixed(4)}). กำลังติดตาม...`);

        // 3. เริ่มติดตามการเคลื่อนที่
        navigator.geolocation.watchPosition(async (position) => {
          const { latitude, longitude } = position.coords;
          const now = Date.now();

          // Throttling: ส่งข้อมูลสูงสุดทุกๆ 2 วินาที (ป้องกันการรัว)
          if (now - lastSentRef.current < 2000) {
              return; 
          }
          lastSentRef.current = now;

          // เช็คระยะห่างจากจุดเริ่มต้น (startLat, startLng)
          checkGeofence(latitude, longitude, startLat, startLng);

          // อัปเดตพิกัดลงตาราง locations
          const { error } = await supabase
            .from('locations')
            .upsert({ 
              id: 1, 
              user_id: 'patient_001', 
              lat: latitude, 
              lng: longitude,
              created_at: new Date().toISOString()
            });

          if (error) {
             console.error('Error sending location:', error.message);
             setStatus(`เกิดข้อผิดพลาด: ${error.message}`);
          }
        }, (err) => {
          console.error(err)
          setStatus("เกิดข้อผิดพลาดการติดตาม: " + err.message)
        }, { enableHighAccuracy: true });

      }, (err) => {
         console.error(err);
         setStatus("ไม่สามารถระบุจุดเริ่มต้นได้: " + err.message);
      }, { enableHighAccuracy: true });

    } else {
      setStatus("Browser ไม่รองรับ Geolocation")
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-gray-50">
      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center">
        <h1 className="text-2xl font-bold mb-6 text-gray-800">Sender App</h1>
        
        <div className="mb-8">
          <p className={`text-xl font-bold ${statusColor} mb-2`}>{status}</p>
          {distance !== null && (
            <p className="text-gray-500">
              ระยะห่างจากจุดปลอดภัย: <span className="font-mono text-gray-800">{distance.toFixed(2)}</span> ม.
            </p>
          )}
        </div>

        <button 
          onClick={sendLocation}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white px-6 py-4 rounded-xl font-bold text-lg transition-all shadow-lg hover:shadow-blue-500/30 active:scale-95"
        >
          เริ่มส่งตำแหน่ง (Start Tracking)
        </button>

        <p className="mt-4 text-xs text-gray-400">
            *กรุณาเปิดหน้าจอนี้ค้างไว้เพื่อการส่งสัญญาณที่ต่อเนื่อง (ระบบจะป้องกันหน้าจอดับอัตโนมัติ)
        </p>

        {/* Hidden Audio for Background Keep-Alive */}
        <audio 
            ref={audioRef} 
            loop 
            src="https://assets.mixkit.co/active_storage/sfx/212/212.wav" 
            className="hidden" 
        />
      </div>
    </div>
  );
}