import React, { useEffect, useState } from 'react';
import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Wind, Thermometer, Droplets, Activity, AlertTriangle, CloudRain, ShieldAlert } from 'lucide-react';

// 1. Supabase Support
// Replace with your real URL and Anon Key from the Supabase Dashboard
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MQTT_BROKER = 'wss://broker.emqx.io:8084/mqtt'; 
const MQTT_TOPIC = 'iaq/palakkad/datamos';

const getLocalDateString = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function App() {
  const [liveData, setLiveData] = useState(null);
  const [history, setHistory] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  
  // Date State for History Chart
  const [selectedDate, setSelectedDate] = useState(() => getLocalDateString());
  const [latestCloudRecord, setLatestCloudRecord] = useState(null);

  // 1. Fetch ABSOLUTE latest record on mount (for immediate card population)
  useEffect(() => {
    const fetchLatest = async () => {
      const { data, error } = await supabase
        .from('sensor_data')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(1);
      
      if (!error && data && data.length > 0) {
        setLatestCloudRecord(data[0]);
      }
    };
    fetchLatest();
  }, []);

  // Toggle for extra metrics
  const [showExtra, setShowExtra] = useState(false);

  // Chart visibility state
  const [visibleCharts, setVisibleCharts] = useState({
    aqi: true,
    co2: true,
    tvoc: false,
    pm25: false,
    pm10: false,
    no2: false
  });

  const toggleChart = (key) => {
    setVisibleCharts(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Helper to safely format timestamp
  const formatTimeStr = (ts) => {
    if (!ts) return "";
    const ms = ts > 100000000000 ? ts : ts * 1000;
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
  };
  
  const formatFullDateStr = (ts) => {
    if (!ts) return "";
    const ms = ts > 100000000000 ? ts : ts * 1000;
    const date = new Date(ms);
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  };

  // 2. Fetch History from Supabase
  useEffect(() => {
    const fetchHistory = async () => {
      if (!SUPABASE_URL || SUPABASE_URL.includes('your-project')) {
        console.warn("Supabase credentials not configured in frontend/.env!");
        return;
      }

      console.log("Fetching cloud history for:", selectedDate);
      
      // Calculate start and end of day in UTC but aligned to IST (+5.5)
      const [y, m, d] = selectedDate.split('-').map(Number);
      
      // 00:00:00 IST is 18:30:00 UTC the previous day
      const startOfDayIST = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const startTs = Math.floor((startOfDayIST.getTime() - istOffsetMs) / 1000);
      const endTs = startTs + 86399;

      const { data, error } = await supabase
        .from('sensor_data')
        .select('*')
        .gte('timestamp', startTs)
        .lte('timestamp', endTs)
        .order('timestamp', { ascending: true })
        .limit(10000);

      if (error) {
        console.error("Supabase fetch error:", error.message);
        return;
      }

      if (data && data.length > 0) {
        console.log(`Successfully fetched ${data.length} records for IST date ${selectedDate}`);
        const formatted = data.map(d => ({
          ...d,
          timeStr: formatTimeStr(d.timestamp),
          fullDateStr: formatFullDateStr(d.timestamp)
        }));
        setHistory(formatted);
        // If we are looking at "Today", update the card fallback as well
        if (selectedDate === getLocalDateString()) {
          setLatestCloudRecord(data[data.length - 1]);
        }
      } else {
        console.log(`No records found for the range: ${new Date(startTs * 1000).toISOString()} to ${new Date(endTs * 1000).toISOString()}`);
        setHistory([]);
      }
    };

    fetchHistory();
  }, [selectedDate]);

  // 3. Real-time Subscription (Optional but powerful)
  useEffect(() => {
    const channel = supabase
      .channel('sensor-updates')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_data' }, (payload) => {
        const newRow = payload.new;
        
        // Update history optimistically if viewing today
        if (selectedDate === getLocalDateString()) {
          setHistory(prev => [...prev, {
            ...newRow,
            timeStr: formatTimeStr(newRow.timestamp),
            fullDateStr: formatFullDateStr(newRow.timestamp)
          }]);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedDate]);

  // 4. MQTT Connection (Same as before)
  useEffect(() => {
    const client = mqtt.connect(MQTT_BROKER, {
      clientId: `iaq_cloud_${Math.random().toString(16).slice(3)}`,
      clean: true,
      connectTimeout: 4000,
    });

    client.on('connect', () => {
      setIsConnected(true);
      client.subscribe(MQTT_TOPIC);
    });

    client.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        setLiveData(payload);
      } catch (e) {
        console.error("MQTT Parse error:", e);
      }
    });

    return () => {
      client.end();
    };
  }, []);

  // Helper formatting for UI
  const getCategoryColor = (aqi) => {
    if (aqi <= 50) return 'var(--status-good)';
    if (aqi <= 100) return 'var(--status-good)';
    if (aqi <= 200) return 'var(--status-fair)';
    return 'var(--status-poor)';
  };

  const getCategoryText = (aqi) => {
    if (aqi <= 50) return 'Good';
    if (aqi <= 100) return 'Satisfactory';
    if (aqi <= 200) return 'Moderate';
    if (aqi <= 300) return 'Poor';
    if (aqi <= 400) return 'Very Poor';
    return 'Severe';
  };

  const isViewingToday = selectedDate === getLocalDateString();
  const hasLiveData = isViewingToday && liveData;
  const displayData = hasLiveData 
    ? liveData 
    : (history.length > 0 
        ? history[history.length - 1] 
        : (latestCloudRecord || {})
      );

  let {
    aqi = 0, dominant = '-', co2 = 0, tvoc = 0, co = 0, no2 = 0, nh3 = 0,
    pm1 = 0, pm25 = 0, pm10 = 0, temp = 0, hum = 0,
    si_co = 0, si_no2 = 0, si_nh3 = 0, si_co2 = 0, si_tvoc = 0, si_pm25 = 0, si_pm10 = 0
  } = displayData;

  // Fix for faulty MiCS sensors: if value is 0, subindex should be 0 (ignore the 500 error)
  if (co === 0) si_co = 0;
  if (no2 === 0) si_no2 = 0;
  if (nh3 === 0) si_nh3 = 0;

  // Recalculate AQI dynamically based on the corrected sub-indices
  aqi = Math.max(si_co, si_no2, si_nh3, si_co2, si_tvoc, si_pm25, si_pm10);
  
  if (aqi === si_pm25) dominant = "PM2.5";
  else if (aqi === si_pm10) dominant = "PM10";
  else if (aqi === si_co2) dominant = "CO2";
  else if (aqi === si_tvoc) dominant = "TVOC";
  else if (aqi === si_co) dominant = "CO";
  else if (aqi === si_no2) dominant = "NO2";
  else dominant = "NH3";

  return (
    <div className="app-container">
      <header className="header animate-fade-in" style={{ animationDelay: '0.1s' }}>
        <div>
          <h1>AeroSense Dashboard</h1>
          <p>Indoor Air Quality Monitoring</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
          <div className="live-badge">
            <div className="dot" style={{ backgroundColor: isConnected ? 'var(--status-good)' : 'var(--status-poor)'}}></div>
            {isConnected ? 'LIVE CLOUD CONNECTED' : 'OFFLINE'}
          </div>
          {!hasLiveData && (
            <div style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-secondary)', background: 'var(--glass-bg)', padding: '0.25rem 0.75rem', borderRadius: '12px', border: '1px solid var(--glass-border)' }}>
              VIEWING PAST DATA
            </div>
          )}
        </div>
      </header>

      <div className="dashboard-grid">
        <div className="glass-panel aqi-card animate-fade-in animate-pulse-glow" style={{ animationDelay: '0.2s' }}>
          <div className="icon-container" style={{ width: '60px', height: '60px', marginBottom: '1rem' }}><Wind size={32} /></div>
          <h2 className="aqi-label">Overall AQI</h2>
          <div className="aqi-value-container"><span className="aqi-value">{aqi}</span></div>
          <div className="aqi-category" style={{ color: getCategoryColor(aqi) }}>{getCategoryText(aqi)}</div>
          <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Dominant: <strong style={{ color: 'var(--text-primary)'}}>{dominant}</strong></p>
        </div>

        <div className="metrics-grid">
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '1rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Key Air Metrics</h3>
            <button 
              onClick={() => setShowExtra(!showExtra)}
              className="chart-toggle-btn" 
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: showExtra ? 'var(--accent-primary)' : 'rgba(255,255,255,0.4)', color: showExtra ? '#fff' : 'inherit' }}
            >
              {showExtra ? '-' : '+'} Manage Sensors
            </button>
          </div>

          <MetricCard delay="0.3s" title="CO2 Level" value={co2.toFixed(1)} unit="ppm" icon={<Wind />} colorClass="blue" subindex={si_co2} />
          <MetricCard delay="0.4s" title="TVOCs" value={tvoc.toFixed(0)} unit="ppb" icon={<Activity />} colorClass="purple" subindex={si_tvoc} />
          <MetricCard delay="0.5s" title="PM 2.5" value={pm25.toFixed(1)} unit="µg/m³" icon={<CloudRain />} colorClass="red" subindex={si_pm25} />
          <MetricCard delay="0.6s" title="PM 10.0" value={pm10.toFixed(1)} unit="µg/m³" icon={<CloudRain />} colorClass="orange" subindex={si_pm10} />

          {showExtra && (
            <>
              <MetricCard delay="0.1s" title="PM 1.0" value={pm1.toFixed(1)} unit="µg/m³" icon={<CloudRain />} colorClass="orange" />
              <MetricCard delay="0.2s" title="CO Level" value={co.toFixed(2)} unit="ppm" icon={<AlertTriangle />} colorClass="red" subindex={si_co} />
              <MetricCard delay="0.3s" title="NO2 Level" value={no2.toFixed(2)} unit="ppm" icon={<ShieldAlert />} colorClass="purple" subindex={si_no2} />
              <MetricCard delay="0.4s" title="Ammonia (NH3)" value={nh3.toFixed(2)} unit="ppm" icon={<ShieldAlert />} colorClass="green" subindex={si_nh3} />
            </>
          )}

          <MetricCard delay="0.9s" title="Temperature" value={temp.toFixed(1)} unit="°C" icon={<Thermometer />} colorClass="orange" />
          <MetricCard delay="1.0s" title="Humidity" value={hum.toFixed(1)} unit="%" icon={<Droplets />} colorClass="blue" />
        </div>
      </div>

      <div className="glass-panel charts-section animate-fade-in" style={{ animationDelay: '1.1s' }}>
        <div className="charts-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <h2 className="charts-title" style={{ fontSize: '1.4rem', fontWeight: 'bold', color: 'var(--text-primary)' }}>Historical Trends Analytics</h2>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="date-picker-input" />
          </div>
          <div className="chart-toggles">
            <button className={`chart-toggle-btn aqi ${visibleCharts.aqi ? 'active' : ''}`} onClick={() => toggleChart('aqi')}>AQI</button>
            <button className={`chart-toggle-btn co2 ${visibleCharts.co2 ? 'active' : ''}`} onClick={() => toggleChart('co2')}>CO2</button>
            <button className={`chart-toggle-btn tvoc ${visibleCharts.tvoc ? 'active' : ''}`} onClick={() => toggleChart('tvoc')}>TVOC</button>
            <button className={`chart-toggle-btn pm25 ${visibleCharts.pm25 ? 'active' : ''}`} onClick={() => toggleChart('pm25')}>PM 2.5</button>
            <button className={`chart-toggle-btn pm10 ${visibleCharts.pm10 ? 'active' : ''}`} onClick={() => toggleChart('pm10')}>PM 10</button>
            <button className={`chart-toggle-btn no2 ${visibleCharts.no2 ? 'active' : ''}`} onClick={() => toggleChart('no2')}>NO2</button>
          </div>
        </div>
        <div style={{ width: '100%', height: '350px', position: 'relative' }}>
          {history.length === 0 ? (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--text-secondary)' }}>
              <h3>No cloud data for {selectedDate}</h3>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorAqi" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent-primary)" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="var(--accent-primary)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorCo2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent-secondary)" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="var(--accent-secondary)" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorTvoc" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorPm25" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorNo2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.6}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="timeStr" stroke="var(--text-secondary)" tick={{fontSize: 12}} />
                <YAxis yAxisId="left" stroke="var(--text-secondary)" tick={{fontSize: 12}} />
                <YAxis yAxisId="right" orientation="right" stroke="var(--text-secondary)" tick={{fontSize: 12}} />
                <CartesianGrid strokeDasharray="3 3" stroke="var(--glass-border)" vertical={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'rgba(255, 255, 255, 0.8)', borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}
                  labelStyle={{ fontWeight: 'bold', marginBottom: '4px' }}
                />
                {visibleCharts.aqi && <Area yAxisId="left" type="monotone" dataKey="aqi" stroke="var(--accent-primary)" strokeWidth={3} fillOpacity={1} fill="url(#colorAqi)" />}
                {visibleCharts.co2 && <Area yAxisId="right" type="monotone" dataKey="co2" stroke="var(--accent-secondary)" strokeWidth={2} fillOpacity={1} fill="url(#colorCo2)" />}
                {visibleCharts.tvoc && <Area yAxisId="right" type="monotone" dataKey="tvoc" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#colorTvoc)" />}
                {visibleCharts.pm25 && <Area yAxisId="left" type="monotone" dataKey="pm25" stroke="#ef4444" strokeWidth={2} fillOpacity={1} fill="url(#colorPm25)" />}
                {visibleCharts.pm10 && <Area yAxisId="left" type="monotone" dataKey="pm10" stroke="#ef4444" strokeWidth={2} strokeDasharray="5 5" fillOpacity={0} />}
                {visibleCharts.no2 && <Area yAxisId="left" type="monotone" dataKey="no2" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorNo2)" />}            
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, unit, icon, colorClass, delay, subindex }) {
  return (
    <div className="glass-panel metric-card animate-fade-in" style={{ animationDelay: delay }}>
      <div className="metric-header"><span className="metric-title"><div className={`icon-container ${colorClass}`}>{icon}</div>{title}</span></div>
      <div className="metric-value-row"><span className="metric-value">{value}</span><span className="metric-unit">{unit}</span></div>
      {subindex !== undefined && <div className="metric-subindex">SI: <strong>{subindex}</strong></div>}
    </div>
  );
}

export default App;
