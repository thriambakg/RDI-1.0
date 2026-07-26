# Raspberry Pi CM4 to Desktop HITL Simulation: RFD900x Hardware & Software Guide

This document covers the complete hardware wiring, jumper layout, and asynchronous Python daemon bridge architecture required to stream WebRTC commands from a web platform over a 900MHz radio telemetry link to a desktop Hardware-in-the-Loop (HITL) drone simulation.

---

## 1. Hardware Architecture & Wiring Map

### Ground Side (Desktop Receiver)

* **Antennas:** Attach two **Long-Range Half-Wave Dipole Antennas** (3 dBi) to maximize reception. Never power on the modem without antennas connected.

* **Jumper Configuration:** Leave the plastic jumper block bridging **Pins 4 and 6** on the even row. This safely routes power from the USB port.

* **Cable Connection:** Plug the 6-pin female FTDI/USB cable directly onto the single row of **Odd-numbered pins (1, 3, 5, 7, 9, 11)**. Align the **Black wire (GND)** with **Pin 1** (marked with a white dot/triangle on the PCB).

* **PC Connection:** Plug the USB connector into a high-powered **USB 3.0 port** on your desktop PC to support peak transmit draws (~1A).

### Air Side (Raspberry Pi CM4 / Holybro Baseboard Transmitter)

* **Antennas:** Attach two **Stubby Monopole Antennas** (2.1 dBi) to minimize weight and aerodynamic drag on the airframe.

* **Jumper Configuration:** Leave the plastic jumper block bridging **Pins 4 and 6** on the even row. 

* **Cable Connection:** Plug the **White JST-GH connector** into the **TELEM 1** port on the Holybro Baseboard. Plug the **Black female 6-pin connector** directly onto the single row of **Odd-numbered pins (1, 3, 5, 7, 9, 11)** on the radio modem.

* **Alignment:** Align the **Black wire** of the telemetry cable with **Pin 1** of the modem's odd row. The 4/6 jumper routes the incoming 5V telemetry power correctly to the radio components.

```text

                  RFD900x PIN LAYOUT (LABEL FACING UP)

                           (ANTENNA END)

         2   [4]--[6]   8  10  12  14  16  <-- Even Row (Jumper on 4 & 6)

        (1)  (3)  (5)  (7) (9)(11) 13  15  <-- Odd Row (6-Pin Cable Plugs Here)

           ^

     (PIN 1 MARKER / BLACK WIRE)

```

---

## 2. Raspberry Pi System Configuration

To ensure the Linux operating system does not corrupt your radio data stream with boot messages or login prompts, disable the serial console on your CM4.

1. SSH into the Raspberry Pi after its system update finishes.

2. Open the configuration tool:

   ```bash

   sudo raspi-config

   ```

3. Navigate to: **Interface Options** -> **Serial Port**.

4. Select **No** to: *"Would you like a login shell to be accessible over serial?"*

5. Select **Yes** to: *"Would you like the serial port hardware to be enabled?"*

6. Save the settings and reboot the Pi:

   ```bash

   sudo reboot

   ```

---

## 3. Python Asynchronous Serial Bridge (Cursor Component)

This component uses a thread-safe, non-blocking asynchronous worker queue. Integrating this inside your background daemon prevents real-time WebRTC packet bursts from blocking your primary network or system control loop execution.

### Installation

Install the physical serial interface library on the Pi:

```bash

pip install pyserial

```

### Production-Ready Daemon Script

Save this code in your Python project directory. You can use it as a standalone verification tool or import the class into your main script.

```python

import json

import logging

import queue

import threading

import time

import serial

# Configure clean logging output

logging.basicConfig(level=[logging.INFO](http://logging.INFO), format="%(asctime)s [%(levelname)s] %(message)s")

class WebRTCToRadioBridge:

    def **init**(self, port='/dev/ttyAMA0', baudrate=57600):

        """

        Initializes the communication bridge parameters.

        Default port for Holybro TELEM 1 on CM4 is typically /dev/ttyAMA0.

        """

        self.port = port

        self.baudrate = baudrate

        self.serial_queue = queue.Queue()

        self.running = False

        self.serial_conn = None

        self.tx_thread = None

    def start(self):

        """Opens the physical hardware radio link and launches the TX engine thread."""

        try:

            # Configure industry-standard 8N1 serial communication parameters

            self.serial_conn = serial.Serial(

                port=self.port,

                baudrate=self.baudrate,

                bytesize=serial.EIGHTBITS,

                parity=serial.PARITY_NONE,

                stopbits=serial.STOPBITS_ONE,

                timeout=1

            )

            self.running = True

            

            # Run the serialization loop on a background thread to preserve WebRTC loop performance

            self.tx_thread = threading.Thread(target=self._tx_worker, daemon=True)

            self.tx_thread.start()

            [logging.info](http://logging.info)(f"Radio telemetry link successfully opened on {self.port} at {self.baudrate} baud.")

        except serial.SerialException as e:

            logging.error(f"Failed to open hardware serial port {self.port}: {e}")

            raise

    def queue_command(self, webrtc_payload: dict):

        """

        Safe entry point for your WebRTC data channel thread hooks.

        Accepts a dictionary command payload and stages it for over-the-air transmission.

        """

        if self.running:

            self.serial_queue.put(webrtc_payload)

        else:

            logging.warning("Cannot queue payload; radio telemetry bridge is offline.")

    def *tx*worker(self):

        """Background worker thread responsible for pushing data down the physical pipeline."""

        while self.running:

            try:

                # Grab a command packet from the internal queue (gracefully blocks until data arrives)

                command_data = self.serial_queue.get(timeout=0.5)

                

                # 1. Serialize dictionary data to JSON string with a newline delimiter

                # Note: Swap this parsing block if your desktop HITL strictly requires raw binary or MAVLink

                serialized_payload = json.dumps(command_data) + "\n"

                

                # 2. Transmit raw binary stream across the airwaves

                self.serial_conn.write(serialized_payload.encode('utf-8'))

                self.serial_conn.flush() # Forces immediate physical hardware packet clearance

                

                self.serial_queue.task_done()

            except queue.Empty:

                continue

            except Exception as e:

                logging.error(f"Error encountered during packet transmission over radio link: {e}")

                time.sleep(1) # Grace interval to manage potential serial reconnect loops

    def stop(self):

        """Performs a structured teardown of background threads and serial handles."""

        self.running = False

        if self.tx_thread:

            self.tx_thread.join()

        if self.serial_conn and self.serial_[conn.is](http://conn.is)_open:

            self.serial_conn.close()

        [logging.info](http://logging.info)("Radio telemetry bridge gracefully decommissioned.")

# =====================================================================

# INTEGRATION & TESTING PATTERN:

# =====================================================================

if **name** == "__main__":

    # 1. Initialize and bind the hardware bridge

    bridge = WebRTCToRadioBridge(port='/dev/ttyAMA0', baudrate=57600)

    bridge.start()

    try:

        [logging.info](http://logging.info)("Simulating incoming real-time WebRTC control data stream...")

        while True:

            # Mock structure representing your live incoming WebRTC commands

            mock_webrtc_command = {

                "timestamp": time.time(),

                "command": "NAV_WAYPOINT",

                "params": {"lat": 41.8781, "lng": -87.6298, "alt": 50.0}

            }

            

            # Non-blocking injection into the wireless transmission pipeline

            bridge.queue_command(mock_webrtc_command)

            time.sleep(0.1) # Simulate a standard 10Hz flight navigation stream loop

    except KeyboardInterrupt:

        bridge.stop()

```

---

## 4. Verification & Simulation Testing Loop

1. **Verify Air Side Operation:** Execute the Python daemon script inside your cursor/terminal interface on the Pi. The status LEDs on the Air-side RFD900x will shift pattern to indicate active transmission.

2. **Open Desktop Monitoring:** 

   * **On Windows:** Open a serial shell client like PuTTY, identify your Virtual COM assignment via Device Manager, choose a speed of `57600`, and confirm incoming clean JSON strings are printing to the display.

   * **On Linux:** Use a screen interface command line link:

     ```bash

     screen /dev/ttyUSB0 57600

     ```

3. **Link to Drone HITL Platform:** Route this incoming serial resource `COMx` or `/dev/ttyUSBx`) to your specific simulation backend interface at an identical `57600` baud rate to pass your WebRTC flight commands directly to your simulated drone instance.

