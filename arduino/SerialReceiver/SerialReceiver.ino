// Receives newline-terminated strings from the web interface and echoes them back.
// Baud rate must match the one selected in the web UI.

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("Arduino ready");
}

void loop() {
  if (Serial.available()) {
    String msg = Serial.readStringUntil('\n');
    msg.trim();

    // Blink the LED so you can see something arrived
    digitalWrite(LED_BUILTIN, HIGH);
    delay(50);
    digitalWrite(LED_BUILTIN, LOW);

    Serial.print("Received: ");
    Serial.println(msg);
  }
}
