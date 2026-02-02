import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// เช็คว่ามีค่าครบไหม ถ้าไม่มีให้แสดง Error บอกเรา
if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing Supabase Environment Variables")
}

export const supabase = createClient(
    supabaseUrl || '',
    supabaseAnonKey || ''
)