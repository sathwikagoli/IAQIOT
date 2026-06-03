/*
 * INDOOR AIR QUALITY MONITOR — India-aligned Standards
 * ================================================================
 * Sensors:
 *   - SCD4x     -> CO2, Temperature, Humidity  (I2C1: SDA=2, SCL=1)
 *   - ENS160    -> TVOC, eCO2                  (I2C1: SDA=2, SCL=1)
 *   - PMS5003   -> PM1.0, PM2.5, PM10          (UART2: RX=42, TX=41)
 *
 * Cloud: EMQX Public MQTT Broker
 *
 * NOTE:
 *   Overall AQI is derived from: CO2, TVOC, PM2.5, PM10 only.
 * ================================================================
 */

#include <Wire.h>
#include <SparkFun_SCD4x_Arduino_Library.h>
#include <SparkFun_ENS160.h>

// ================================================================
// DEFINES
// ================================================================

#define EC200U_SERIAL   Serial1
#define EC200U_TX_PIN   13
#define EC200U_RX_PIN   12
#define EC200U_ONOFF    18
#define EC200U_BAUD     115200

#define PMS_SERIAL      Serial2
#define PMS_RX_PIN      41   // GPIO 41 connected to PMS TXD (pin 5)
#define PMS_TX_PIN      42   // GPIO 42 connected to PMS RXD (pin 4)
#define PMS_BAUD        9600

#define SDA_PIN   2
#define SCL_PIN   1
#define NUM_SAMPLES 6

// MQTT
const char* MQTT_HOST   = "broker.emqx.io";
const char* MQTT_USER   = "";
const char* MQTT_PASS   = "";
const char* MQTT_TOPIC  = "iaq/palakkad/datamos";
const int   MQTT_PORT   = 1883;
const char* MQTT_CLIENT = "ESP32-IAQ-01";

unsigned long lastUpload  = 0;
unsigned long uploadEvery = 20000;
bool modemReady = false;

// ================================================================
// SENSOR OBJECTS
// ================================================================

SCD4x mySCD4x;
SparkFun_ENS160 myENS160;

// ================================================================
// ROLLING AVERAGE BUFFERS
// ================================================================

float co2_buf[NUM_SAMPLES]  = {0};
float tvoc_buf[NUM_SAMPLES] = {0};
float pm1_buf[NUM_SAMPLES]  = {0};
float pm25_buf[NUM_SAMPLES] = {0};
float pm10_buf[NUM_SAMPLES] = {0};

int  bufIndex     = 0;
bool bufFull      = false;
bool hasValidData = false;

// ================================================================
// STRUCTS
// ================================================================

struct BP { float cLo, cHi; int iLo, iHi; };

struct PmsData {
  uint16_t pm1_0  = 0;
  uint16_t pm2_5  = 0;
  uint16_t pm10_0 = 0;
  bool valid = false;
};

// ================================================================
// BREAKPOINT TABLES
// ================================================================

BP co2_bp[] = {
  {0,    600,   0,   50},
  {600,  1000,  51,  100},
  {1000, 1500,  101, 200},
  {1500, 2000,  201, 300},
  {2000, 5000,  301, 400},
  {5000, 99999, 401, 500}
};

BP tvoc_bp[] = {
  {0,    65,    0,   50},
  {65,   220,   51,  100},
  {220,  660,   101, 200},
  {660,  2200,  201, 300},
  {2200, 5500,  301, 400},
  {5500, 99999, 401, 500}
};

BP pm25_bp[] = {
  {0,    30,    0,   50},
  {30,   60,    51,  100},
  {60,   90,    101, 200},
  {90,   120,   201, 300},
  {120,  250,   301, 400},
  {250,  99999, 401, 500}
};

BP pm10_bp[] = {
  {0,    50,    0,   50},
  {50,   100,   51,  100},
  {100,  250,   101, 200},
  {250,  350,   201, 300},
  {350,  430,   301, 400},
  {430,  99999, 401, 500}
};

// ================================================================
// AQI HELPERS
// ================================================================

float calcSubIndex(float conc, BP* bp, int n) {
  conc = max(conc, 0.0f);
  for (int i = 0; i < n; i++) {
    if (conc <= bp[i].cHi) {
      return ((float)(bp[i].iHi - bp[i].iLo) /
              (bp[i].cHi - bp[i].cLo)) *
             (conc - bp[i].cLo) + bp[i].iLo;
    }
  }
  return 500;
}

float getAverage(float* buf) {
  int count = bufFull ? NUM_SAMPLES : bufIndex;
  if (count == 0) return 0;
  float sum = 0;
  for (int i = 0; i < count; i++) sum += buf[i];
  return sum / count;
}

String getCategory(int aqi) {
  if (aqi <= 50)  return "Good";
  if (aqi <= 100) return "Satisfactory";
  if (aqi <= 200) return "Moderately Polluted";
  if (aqi <= 300) return "Poor";
  if (aqi <= 400) return "Very Poor";
  return "Severe";
}

String getDominantPollutant(float si_co2, float si_tvoc,
                             float si_pm25, float si_pm10) {
  float worst = si_co2;
  if (si_tvoc > worst) worst = si_tvoc;
  if (si_pm25 > worst) worst = si_pm25;
  if (si_pm10 > worst) worst = si_pm10;

  if (worst == si_pm25) return "PM2.5";
  if (worst == si_pm10) return "PM10";
  if (worst == si_co2)  return "CO2";
  return "TVOC";
}

// ================================================================
// PMS5003 READER
// ================================================================

PmsData readPMS5003() {
  PmsData data;
  long deadline = millis() + 4000;

  while (millis() < deadline) {
    if (!PMS_SERIAL.available()) { delay(1); continue; }
    if (PMS_SERIAL.read() != 0x42) continue;

    long t2 = millis() + 100;
    while (!PMS_SERIAL.available() && millis() < t2) delay(1);
    if (!PMS_SERIAL.available()) continue;
    if (PMS_SERIAL.peek() != 0x4D) continue;
    PMS_SERIAL.read();

    uint8_t buf[30];
    bool frameOK = true;
    for (int i = 0; i < 30; i++) {
      long tb = millis() + 150;
      while (!PMS_SERIAL.available() && millis() < tb) delay(1);
      if (!PMS_SERIAL.available()) {
        Serial.printf("PMS5003: timeout at byte %d\n", i);
        frameOK = false;
        break;
      }
      buf[i] = PMS_SERIAL.read();
    }
    if (!frameOK) continue;

    uint16_t frameLen = ((uint16_t)buf[0] << 8) | buf[1];
    if (frameLen != 0x001C) {
      Serial.printf("PMS5003: bad frame length 0x%04X\n", frameLen);
      continue;
    }

    uint16_t sum = 0x42 + 0x4D;
    for (int i = 0; i < 28; i++) sum += buf[i];
    uint16_t rxCheck = ((uint16_t)buf[28] << 8) | buf[29];

    if (sum != rxCheck) {
      Serial.printf("PMS5003: checksum fail — calc=0x%04X rx=0x%04X\n", sum, rxCheck);
      continue;
    }

    data.pm1_0  = ((uint16_t)buf[8]  << 8) | buf[9];
    data.pm2_5  = ((uint16_t)buf[10] << 8) | buf[11];
    data.pm10_0 = ((uint16_t)buf[12] << 8) | buf[13];
    data.valid  = true;

    Serial.printf("PMS5003 OK — PM1: %d | PM2.5: %d | PM10: %d µg/m3\n",
                  data.pm1_0, data.pm2_5, data.pm10_0);
    return data;
  }

  Serial.println("PMS5003: no valid frame within timeout");
  return data;
}

// ================================================================
// EC200U AT ENGINE
// ================================================================

bool sendAT(const char* cmd, const char* expected, int timeoutMs = 5000) {
  while (EC200U_SERIAL.available()) EC200U_SERIAL.read();
  EC200U_SERIAL.println(cmd);
  String resp = "";
  long deadline = millis() + timeoutMs;
  while (millis() < deadline) {
    while (EC200U_SERIAL.available())
      resp += (char)EC200U_SERIAL.read();
    if (resp.indexOf(expected) >= 0) {
      Serial.print("[AT OK] "); Serial.println(cmd);
      return true;
    }
  }
  Serial.print("[AT FAIL] "); Serial.print(cmd);
  Serial.print(" -> "); Serial.println(resp);
  return false;
}

// ================================================================
// MODEM INIT
// ================================================================

bool initModem() {
  pinMode(EC200U_ONOFF, OUTPUT);
  digitalWrite(EC200U_ONOFF, HIGH);
  delay(500);
  digitalWrite(EC200U_ONOFF, LOW);
  Serial.println("EC200U ON/OFF pulsed, waiting for boot...");

  EC200U_SERIAL.begin(EC200U_BAUD, SERIAL_8N1, EC200U_RX_PIN, EC200U_TX_PIN);
  delay(5000);

  bool atOK = false;
  for (int i = 0; i < 10; i++) {
    Serial.print("AT probe attempt "); Serial.println(i + 1);
    if (sendAT("AT", "OK", 2000)) { atOK = true; break; }
    delay(1000);
  }
  if (!atOK) { Serial.println("EC200U not responding!"); return false; }

  sendAT("ATE0",      "OK");
  sendAT("AT+CMEE=2", "OK");

  if (!sendAT("AT+CPIN?", "READY", 5000)) {
    Serial.println("No SIM detected!"); return false;
  }

  Serial.println("Waiting for Airtel network...");
  bool registered = false;
  for (int i = 0; i < 10; i++) {
    if (sendAT("AT+CREG?", "+CREG: 0,1", 3000) ||
        sendAT("AT+CREG?", "+CREG: 0,5", 3000)) {
      registered = true; break;
    }
    delay(3000);
  }
  if (!registered) Serial.println("Warning: network uncertain, continuing...");

  sendAT("AT+QIDEACT=1", "OK", 5000);
  delay(1000);
  sendAT("AT+QICSGP=1,1,\"airtelgprs.com\",\"\",\"\",1", "OK", 5000);
  if (!sendAT("AT+QIACT=1", "OK", 15000)) {
    sendAT("AT+QIDEACT=1", "OK", 5000);
    delay(1000);
    sendAT("AT+QICSGP=1,1,\"airtel\",\"\",\"\",1", "OK", 5000);
    if (!sendAT("AT+QIACT=1", "OK", 15000)) {
      Serial.println("PDP failed on both APNs!"); return false;
    }
  }

  sendAT("AT+QMTCFG=\"ssl\",0,0",    "OK");
  sendAT("AT+QMTCFG=\"version\",0,4", "OK");

  String openCmd = "AT+QMTOPEN=0,\"" + String(MQTT_HOST) + "\"," + String(MQTT_PORT);
  if (!sendAT(openCmd.c_str(), "+QMTOPEN: 0,0", 15000)) {
    Serial.println("MQTT open failed!"); return false;
  }

  String connCmd = "AT+QMTCONN=0,\"" + String(MQTT_CLIENT) + "\"";
  if (!sendAT(connCmd.c_str(), "+QMTCONN: 0,0,0", 10000)) {
    Serial.println("MQTT connect failed!"); return false;
  }

  Serial.println("EC200U ready — MQTT connected to EMQX!");
  return true;
}

// ================================================================
// MQTT PUBLISH
// ================================================================

bool mqttPublish(String payload) {
  while (EC200U_SERIAL.available()) EC200U_SERIAL.read();

  String pubCmd = "AT+QMTPUB=0,0,0,0,\"" + String(MQTT_TOPIC) + "\"," + String(payload.length());
  if (!sendAT(pubCmd.c_str(), ">", 5000)) return false;

  delay(50);
  EC200U_SERIAL.write((const uint8_t*)payload.c_str(), payload.length());
  EC200U_SERIAL.write((uint8_t)0x1A);
  EC200U_SERIAL.flush();

  String resp = "";
  long t = millis();
  while (millis() - t < 8000) {
    while (EC200U_SERIAL.available()) resp += (char)EC200U_SERIAL.read();
    if (resp.indexOf("+QMTPUB:") >= 0) break;
  }
  Serial.println("MQTT resp: " + resp);
  return resp.indexOf("+QMTPUB: 0,0,0") >= 0;
}

// ================================================================
// CLEAN (remove NaN / Inf for JSON)
// ================================================================

float clean(float v) {
  if (isnan(v) || isinf(v)) return 0;
  return v;
}

// ================================================================
// CLOUD UPLOAD
// ================================================================

void uploadToCloud(float co2,   float tvoc,  float temp,
                   float hum,   int   aqi,
                   float si_co2, float si_tvoc,
                   float pm1,   float pm25,  float pm10,
                   float si_pm25, float si_pm10,
                   String dominant) {

  unsigned long ts = millis() / 1000;

  co2  = clean(co2);  tvoc = clean(tvoc);
  temp = clean(temp); hum  = clean(hum);
  pm1  = clean(pm1);  pm25 = clean(pm25); pm10 = clean(pm10);
  si_co2  = clean(si_co2);  si_tvoc = clean(si_tvoc);
  si_pm25 = clean(si_pm25); si_pm10 = clean(si_pm10);

  String json = "{";
  json += "\"ts\":"         + String(ts)            + ",";
  json += "\"aqi\":"        + String(aqi)            + ",";
  json += "\"dominant\":\"" + dominant               + "\",";
  json += "\"co2\":"        + String(co2,  1)        + ",";
  json += "\"tvoc\":"       + String(tvoc, 0)        + ",";
  json += "\"pm1\":"        + String(pm1,  1)        + ",";
  json += "\"pm25\":"       + String(pm25, 1)        + ",";
  json += "\"pm10\":"       + String(pm10, 1)        + ",";
  json += "\"temp\":"       + String(temp, 1)        + ",";
  json += "\"hum\":"        + String(hum,  1)        + ",";
  json += "\"si_co2\":"     + String((int)si_co2)    + ",";
  json += "\"si_tvoc\":"    + String((int)si_tvoc)   + ",";
  json += "\"si_pm25\":"    + String((int)si_pm25)   + ",";
  json += "\"si_pm10\":"    + String((int)si_pm10);
  json += "}";

  Serial.println("Publishing:");
  Serial.println(json);

  if (mqttPublish(json))
    Serial.println("MQTT: OK");
  else
    Serial.println("MQTT: FAILED");
}

// ================================================================
// SETUP
// ================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Wire.begin(SDA_PIN, SCL_PIN);

  PMS_SERIAL.begin(PMS_BAUD, SERIAL_8N1, PMS_RX_PIN, PMS_TX_PIN);
  Serial.println("PMS5003 serial started — RX=41, TX=42.");

  Serial.println("Initializing sensors...");

  // SCD4x
  if (!mySCD4x.begin(Wire)) {
    Serial.println("SCD4x not detected!"); while (1);
  }
  mySCD4x.startPeriodicMeasurement();
  Serial.println("SCD4x ready.");

  // ENS160 — try 0x53 first (ADDR pin HIGH), fallback to 0x52
  if (!myENS160.begin(Wire, 0x53)) {
    Serial.println("ENS160 not found at 0x53, trying 0x52...");
    if (!myENS160.begin(Wire, 0x52)) {
      Serial.println("ENS160 not detected on either address!"); while (1);
    }
  }
  myENS160.setOperatingMode(SFE_ENS160_STANDARD);
  Serial.println("ENS160 ready.");

  Serial.println("All sensors ready!");

  modemReady = initModem();
  if (!modemReady) Serial.println("Modem init failed — running offline");

  delay(1000);
}

// ================================================================
// LOOP
// ================================================================

void loop() {
  Serial.println("\n=============================");

  float co2_ppm = 0, temp = 0, hum = 0;
  int   tvoc_ppb = 0;
  bool  scdReady = false;

  // ── SCD4x
  if (mySCD4x.readMeasurement()) {
    temp    = mySCD4x.getTemperature();
    hum     = mySCD4x.getHumidity();
    co2_ppm = mySCD4x.getCO2();
    scdReady = true;
    Serial.print("CO2: ");         Serial.print(co2_ppm);
    Serial.print(" ppm | Temp: "); Serial.print(temp, 1);
    Serial.print(" °C | Hum: ");   Serial.print(hum,  1);
    Serial.println(" %");
    // Pass T/RH compensation to ENS160 for better accuracy
    myENS160.setTempCompensation(temp);
    myENS160.setRHCompensation(hum);
  } else {
    Serial.println("SCD4x: Waiting...");
  }

  // ── ENS160 — read unconditionally (not gated on checkDataStatus)
  // so TVOC updates even during the 48hr initial warmup period.
  tvoc_ppb = myENS160.getTVOC();
  uint8_t ensFlags = myENS160.getFlags();
  String ensStatus = (ensFlags == 0) ? "Normal" :
                     (ensFlags == 1) ? "Warming up" :
                     (ensFlags == 2) ? "Initial 48hr" : "No valid output";
  Serial.print("TVOC: ");       Serial.print(tvoc_ppb);
  Serial.print(" ppb | ENS: "); Serial.println(ensStatus);

  // ── PMS5003
  PmsData pms = readPMS5003();

  // ── Push to rolling buffers (only requires SCD4x ready)
  if (scdReady) {
    hasValidData = true;

    co2_buf[bufIndex]  = co2_ppm;
    tvoc_buf[bufIndex] = (float)tvoc_ppb;

    if (pms.valid) {
      pm1_buf[bufIndex]  = (float)pms.pm1_0;
      pm25_buf[bufIndex] = (float)pms.pm2_5;
      pm10_buf[bufIndex] = (float)pms.pm10_0;
    }

    bufIndex++;
    if (bufIndex >= NUM_SAMPLES) { bufIndex = 0; bufFull = true; }
  }

  if (!hasValidData) {
    Serial.println("Waiting for valid data from SCD4x...");
    Serial.println("=============================");
    delay(5000);
    return;
  }

  // ── Sub-indices
  float si_co2  = calcSubIndex(getAverage(co2_buf),  co2_bp,  6);
  float si_tvoc = calcSubIndex(getAverage(tvoc_buf), tvoc_bp, 6);
  float si_pm25 = calcSubIndex(getAverage(pm25_buf), pm25_bp, 6);
  float si_pm10 = calcSubIndex(getAverage(pm10_buf), pm10_bp, 6);

  // ── Final AQI — CO2, TVOC, PM2.5, PM10
  float finalF = si_co2;
  if (si_tvoc > finalF) finalF = si_tvoc;
  if (si_pm25 > finalF) finalF = si_pm25;
  if (si_pm10 > finalF) finalF = si_pm10;
  int finalAQI = (int)finalF;

  String dominant = getDominantPollutant(si_co2, si_tvoc, si_pm25, si_pm10);

  Serial.println("-----------------------------");
  Serial.print("Sub-indices | CO2: "); Serial.print((int)si_co2);
  Serial.print(" | TVOC: ");           Serial.print((int)si_tvoc);
  Serial.print(" | PM2.5: ");          Serial.print((int)si_pm25);
  Serial.print(" | PM10: ");           Serial.println((int)si_pm10);
  Serial.print("ENS160 status: ");     Serial.println(ensStatus);
  Serial.print("Dominant: ");          Serial.println(dominant);
  Serial.print(">>> FINAL AQI: ");     Serial.print(finalAQI);
  Serial.print(" — ");                 Serial.println(getCategory(finalAQI));
  Serial.println("=============================");

  // ── Upload
  if (modemReady && millis() - lastUpload > uploadEvery) {
    uploadToCloud(
      getAverage(co2_buf),  getAverage(tvoc_buf),
      temp, hum, finalAQI,
      si_co2, si_tvoc,
      getAverage(pm1_buf),  getAverage(pm25_buf), getAverage(pm10_buf),
      si_pm25, si_pm10, dominant
    );
    lastUpload = millis();
  }

  delay(5000);
}
