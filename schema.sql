-- SQL Script for Supabase SQL Editor
-- This creates the sensor_data table and sets up basic security.

-- 1. Create the table
CREATE TABLE IF NOT EXISTS sensor_data (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    timestamp BIGINT NOT NULL, -- Unix timestamp in seconds
    aqi INTEGER,
    dominant TEXT,
    co2 REAL,
    tvoc REAL,
    co REAL,
    no2 REAL,
    nh3 REAL,
    pm1 REAL,
    pm25 REAL,
    pm10 REAL,
    temp REAL,
    hum REAL,
    si_co INTEGER,
    si_no2 INTEGER,
    si_nh3 INTEGER,
    si_co2 INTEGER,
    si_tvoc INTEGER,
    si_pm25 INTEGER,
    si_pm10 INTEGER
);

-- 2. Create index for fast date queries
CREATE INDEX IF NOT EXISTS idx_sensor_timestamp ON sensor_data (timestamp DESC);

-- 3. Enable Real-time (Optional, but recommended)
-- Run this to allow the dashboard to listen for new rows:
ALTER TABLE sensor_data REPLICA IDENTITY FULL;
-- Then go to Database -> Replication -> Enable for 'sensor_data' in UI.

-- 4. Set up Row Level Security (RLS)
-- To keep it simple for your private dashboard:
ALTER TABLE sensor_data ENABLE ROW LEVEL SECURITY;

-- Allow everyone to read (Select)
CREATE POLICY "Allow public read access" ON sensor_data FOR SELECT USING (true);

-- Allow everyone to insert (Insert) - Note: In production you should use a secret service key for the bridge
CREATE POLICY "Allow public insert access" ON sensor_data FOR INSERT WITH CHECK (true);

-- 5. Create an RPC function to calculate averages over a date range
CREATE OR REPLACE FUNCTION get_pollutant_averages(start_ts bigint, end_ts bigint)
RETURNS TABLE (
    avg_aqi numeric,
    avg_co2 numeric,
    avg_tvoc numeric,
    avg_pm25 numeric,
    avg_pm10 numeric
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ROUND(AVG(aqi)::numeric, 1) as avg_aqi,
        ROUND(AVG(co2)::numeric, 1) as avg_co2,
        ROUND(AVG(tvoc)::numeric, 1) as avg_tvoc,
        ROUND(AVG(pm25)::numeric, 1) as avg_pm25,
        ROUND(AVG(pm10)::numeric, 1) as avg_pm10
    FROM sensor_data
    WHERE timestamp >= start_ts AND timestamp <= end_ts;
END;
$$ LANGUAGE plpgsql;
