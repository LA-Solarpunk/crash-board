/*
 * CRASH Space Bus Tracker v3 - Transit API Edition
 * Works anywhere - just set your lat/lon in config.h
 * 
 * Hardware:
 * - ESP32-WROOM-32
 * - 40x2 VFD display (Noritake SLIMP3)
 * - Tactile button: one side to GPIO 13, other to GND
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <LiquidCrystal.h>
#include "config.h"  // user config - edit this file, not the sketch

// === PINS ===
const int RS = 19, E = 23, D4 = 18, D5 = 17, D6 = 16, D7 = 15;

// === TIMING ===
unsigned long lastApiFetch = 0;
unsigned long lastButtonPress = 0;
const unsigned long BUTTON_DEBOUNCE = 500; // 500ms debounce

// quota tracking
int apiCallsToday = 0;
int manualRefreshesToday = 0;
int lastResetDay = -1;

LiquidCrystal lcd(RS, E, D4, D5, D6, D7);

// time config
const char* ntpServer = "pool.ntp.org";

// live tracking icon
byte liveIcon0[8] = {
  0b00000,
  0b00000,
  0b00000,
  0b11000,  // ██
  0b00100,  //   █
  0b11010,  // ██ █
  0b11010,  // ██ █
  0b00000
};

byte liveIcon1[8] = {
  0b00000,
  0b00000,
  0b01100,  //  ██
  0b00010,  //    █
  0b00001,  //     █
  0b11001,  // ██  █
  0b11000,  // ██
  0b00000
};

byte liveIcon2[8] = {
  0b00000,
  0b00000,
  0b01100,  //  ██
  0b00010,  //    █
  0b00001,  //     █
  0b11001,  // ██  █
  0b11000,  // ██
  0b00000
};

struct Departure {
  String route;
  String destination;
  int secondsUntil;
  bool isLive;
  String stopName;
};

std::vector<Departure> departures;
String lastLine1 = "";
String lastLine2 = "";

void setup() {
  Serial.begin(115200);
  
  // button setup
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  // lcd init
  lcd.begin(40, 2);
  lcd.noCursor();
  lcd.noBlink();
  lcd.clear();
  
  // register live tracking icon
  lcd.createChar(0, liveIcon0);
  lcd.createChar(1, liveIcon1);
  lcd.createChar(2, liveIcon2);
  
  // show location
  lcd.print("CRASH Space Bus Tracker v3");
  lcd.setCursor(0, 1);
  char locBuf[40];
  sprintf(locBuf, "Location: %.4f, %.4f", LOCATION_LAT, LOCATION_LON);
  lcd.print(locBuf);
  delay(3000);
  
  // connect wifi
  lcd.clear();
  lcd.print("connecting wifi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    attempts++;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    lcd.clear();
    lcd.print("ERROR: no wifi");
    while(1) delay(1000);
  }
  
  // sync time
  lcd.clear();
  lcd.print("syncing time...");
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, ntpServer);
  
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 10000)) {
    lcd.clear();
    lcd.print("ERROR: time sync");
    delay(5000);
  }
  
  lcd.clear();
  lcd.print("ready!");
  delay(1000);
  
  // initial fetch
  fetchTransitData(false);
}

void loop() {
  checkButton();
  
  // check if we should auto-refresh
  if (shouldRefresh()) {
    fetchTransitData(false);
  }
  
  updateDisplay();
  delay(100);
}

bool shouldRefresh() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return false;
  
  int hour = timeinfo.tm_hour;
  
  // quiet hours (10pm - 6am): no auto refresh
  if (hour >= 22 || hour < 6) {
    return false;
  }
  
  // active hours: every 30 min
  unsigned long timeSinceLastFetch = millis() - lastApiFetch;
  return timeSinceLastFetch >= (30 * 60 * 1000); // 30 minutes
}

void checkButton() {
  // check for button press
  if (digitalRead(BUTTON_PIN) == LOW) {
    unsigned long now = millis();
    
    // debounce
    if (now - lastButtonPress > BUTTON_DEBOUNCE) {
      lastButtonPress = now;
      
      // manual refresh
      lcd.clear();
      lcd.print("refreshing...");
      fetchTransitData(true); // force=1
      manualRefreshesToday++;
      
      Serial.printf("Manual refresh #%d today\n", manualRefreshesToday);
    }
  }
}

void fetchTransitData(bool forceRefresh) {
  // reset daily counters
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    if (lastResetDay != timeinfo.tm_mday) {
      apiCallsToday = 0;
      manualRefreshesToday = 0;
      lastResetDay = timeinfo.tm_mday;
      Serial.println("Daily counters reset");
    }
  }
  
  HTTPClient http;
  
  // build url
  char url[256];
  sprintf(url, "%s?lat=%.6f&lon=%.6f%s", 
          WORKER_URL, LOCATION_LAT, LOCATION_LON, 
          forceRefresh ? "&force=1" : "");
  
  http.begin(url);
  int httpCode = http.GET();
  
  Serial.printf("HTTP: %d\n", httpCode);
  
  if (httpCode == 200) {
    String payload = http.getString();
    Serial.printf("Response size: %d bytes\n", payload.length());
    Serial.println("Raw response:");
    Serial.println(payload);
    DynamicJsonDocument doc(16384); // 16KB should be plenty
    DeserializationError error = deserializeJson(doc, payload);
    
    if (!error) {
      departures.clear();
      
      JsonArray deps = doc["departures"];
      for (JsonObject dep : deps) {
        Departure d;
        d.route = dep["route"].as<String>();
        d.destination = dep["destination"].as<String>();
        d.secondsUntil = dep["seconds_until"].as<int>();
        d.isLive = dep["is_live"].as<bool>();
        d.stopName = dep["stop_name"].as<String>();
        
        departures.push_back(d);
      }
      
      bool cached = doc["cached"].as<bool>();
      int ageSeconds = doc["age_seconds"] | 0;
      
      Serial.printf("Got %d departures, cached=%d, age=%ds\n", 
                    departures.size(), cached, ageSeconds);
      
      lastApiFetch = millis();
      apiCallsToday++;
      
      Serial.printf("API calls today: %d auto + %d manual = %d total\n",
                    apiCallsToday - manualRefreshesToday,
                    manualRefreshesToday,
                    apiCallsToday);
    } else {
      Serial.printf("JSON parse error: %s\n", error.c_str());
    }
  } else {
    Serial.printf("HTTP error: %d\n", httpCode);
  }
  
  http.end();
}

void updateDisplay() {
  String line1, line2;
  
  if (departures.size() == 0) {
    line1 = "no buses found nearby";
    line2 = "";
  } else {
    // line 1: next bus
    Departure& next = departures[0];
    
    int minsUntil = next.secondsUntil / 60;
    
    if (next.secondsUntil < 0) {
      line1 = "NEXT: [" + next.route + "] " + next.destination + " - BOARDING ";
    } else if (next.secondsUntil < 90) {
      line1 = "NEXT: [" + next.route + "] " + next.destination + " - ARRIVING ";
    } else if (minsUntil < 60) {
      char buf[32];
      sprintf(buf, "%d min", minsUntil);
      line1 = "NEXT: [" + next.route + "] " + next.destination + " - " + String(buf) + " ";
    } else {
      char buf[32];
      sprintf(buf, "%dh%02dm", minsUntil / 60, minsUntil % 60);
      line1 = "NEXT: [" + next.route + "] " + next.destination + " - " + String(buf) + " ";
    }
    
    // line 2: second bus or data age
    if (departures.size() > 1) {
      Departure& second = departures[1];
      int mins2 = second.secondsUntil / 60;
      
      char buf[40];
      if (mins2 < 60) {
        sprintf(buf, " 2nd: [%s] %s - %dm", 
                second.route.c_str(),
                second.destination.substring(0, 12).c_str(),
                mins2);
      } else {
        sprintf(buf, " 2nd: [%s] %s - %dh%02dm",
                second.route.c_str(),
                second.destination.substring(0, 10).c_str(),
                mins2 / 60, mins2 % 60);
      }
      line2 = String(buf);
    } else {
      // show data age
      unsigned long ageSec = (millis() - lastApiFetch) / 1000;
      int ageMins = ageSec / 60;
      char buf[32];
      sprintf(buf, " updated %dm ago", ageMins);
      line2 = String(buf);
    }
  }
  
  // update display if changed
  if (line1 != lastLine1) {
    lcd.setCursor(0, 0);
    lcd.print(line1);
    // pad with spaces to clear old content
    for (int i = line1.length(); i < 40; i++) {
      lcd.print(" ");
    }
    
    // add live icon if needed
    if (departures.size() > 0 && departures[0].isLive && 
        (departures[0].secondsUntil >= 0 || departures[0].secondsUntil < 180)) {
      static unsigned long lastFrame = 0;
      static int frame = 0;
      if (millis() - lastFrame > 500) {
        frame = (frame + 1) % 3;
        lastFrame = millis();
      }
      lcd.setCursor(line1.length(), 0);
      lcd.write(byte(frame));
      lcd.setCursor(0, 0);
    }
    
    lastLine1 = line1;
  }
  
  if (line2 != lastLine2) {
    lcd.setCursor(0, 1);
    lcd.print(line2);
    for (int i = line2.length(); i < 32; i++) {
      lcd.print(" ");
    }
    lastLine2 = line2;
  }
  
  // always show clock
  String clock = getCurrentTime();
  lcd.setCursor(32, 1);
  lcd.print(clock);
}

String getCurrentTime() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return "??:??:??";
  
  char buf[9];
  sprintf(buf, "%02d:%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  return String(buf);
}
