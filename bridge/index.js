const mqtt = require('mqtt');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// 1. Configuration
const MQTT_BROKER = process.env.MQTT_BROKER || 'wss://test.mosquitto.org:8081/mqtt';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'iaq/palakkad/data';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use Service Role key for 24/7 insertion

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase credentials in .env file!');
    process.exit(1);
}

// 2. Setup Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const client = mqtt.connect(MQTT_BROKER, {
    clientId: 'nodejs-iaq-backend-' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 5000
});

client.on('connect', () => {
    console.log(`Connected to MQTT Broker: ${MQTT_BROKER}`);
    client.subscribe(MQTT_TOPIC, (err) => {
        if (!err) {
            console.log(`Subscribed to topic: ${MQTT_TOPIC}`);
        }
    });
});

client.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        console.log('Received data:', payload);

        // Strip the 'ts' field sent by the modem (it's just uptime)
        // because our Supabase table uses 'timestamp' for server-side time.
        const { ts, ...sensorData } = payload;

        // Add server-side timestamp (seconds)
        const serverTs = Math.floor(Date.now() / 1000);

        // 3. Insert into Supabase
        const { error } = await supabase
            .from('sensor_data')
            .insert([{
                ...sensorData,
                timestamp: serverTs
            }]);

        if (error) {
            console.error('Supabase Insert Error:', error.message);
        } else {
            console.log('Data successfully logged to Supabase.');
        }

    } catch (e) {
        console.error('Error processing MQTT message:', e.message);
    }
});

client.on('error', (err) => {
    console.error('MQTT Connection Error:', err);
});
