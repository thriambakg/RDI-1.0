# UAV Hardware Architecture — Updated Design

**Updated:** October 22, 2026  
**Status:** Proposed architecture; interfaces and performance require validation before production.

## 1. System overview

A Holybro X500 V2 quadcopter carries a Pixhawk 6X flight controller, a Jetson Orin Nano/NX companion computer, and a SIYI R1M Ethernet camera. A pair of Microhard **pMDDL900-ENC** 900 MHz digital data links transports **MAVLink telemetry, RTSP video, and object-detection metadata** between the aircraft and a Raspberry Pi CM4 ground station. The ground station can use Starlink for onward connectivity.

**Key design choice:** Perform object detection onboard the Jetson so detection can continue during a radio outage. The Pixhawk remains responsible for flight stabilization and safety-critical failsafes.

## 2. Logical architecture

```text
                         AIRCRAFT — HOLYBRO X500 V2

  4S LiPo (14.8 V nominal, 16.8 V full)
      |-- Flight power distribution / ESCs / motors
      |-- Pixhawk-compatible power module --> Pixhawk 6X
      |-- Suitable regulated supply -------> Jetson + carrier board
      |-- Fused, filtered supply ----------> Microhard pMDDL900-ENC
      `-- Regulated 12 V supply -----------> SIYI R1M camera (3 W)

  SIYI R1M -- custom 6-pin/8-pin-to-Ethernet harness --+
                                                       |
  Jetson Orin Nano/NX <-- Ethernet --> [Onboard Ethernet switch/network]
        |                                              |
        | RTSP decode + object detection + tracking    |
        | Publishes bounding boxes / classes / IDs     |
        |                                              |
  Pixhawk 6X <-- UART/CAN/MAVLink --> Jetson carrier    |
        |                                              |
        `-- Flight control and independent failsafes   |
                                                       |
                        Microhard pMDDL900-ENC <--------+
                         2 x 900 MHz 3 dBi dipoles*
                                   ))
                              900 MHz RF link
                                   ((
                         2 x 900 MHz 3 dBi dipoles*
                        Ground Microhard pMDDL900-ENC
                                   |
                                Ethernet
                                   |
                       Raspberry Pi CM4 ground station
                         |                  |
                  Operator UI / GCS    Starlink / WAN
                  Video + detections   Remote services
```

*Existing RFD900x antennas are candidates, not yet confirmed as authorized for the Microhard radio.*

**Network behavior:** The camera and Jetson are on the same onboard Ethernet network as the airborne Microhard. The Jetson subscribes to the camera's RTSP stream locally. The ground station can subscribe to the same camera stream across the Microhard link if routing/bridging, camera session capacity, and available throughput permit. The Jetson separately publishes compact detection metadata. **Do not assume the Jetson must decode and re-encode the video to send it to ground.**

## 3. Airborne hardware

| Subsystem | Selected / planned hardware | Function and interface |
|---|---|---|
| Airframe | Holybro X500 V2 ARF | Quadcopter platform, motors, ESCs and propulsion |
| Flight controller | Holybro Pixhawk 6X | Stabilization, navigation, MAVLink, RTL/land failsafes |
| Flight-controller/companion carrier | Holybro Pixhawk Jetson Baseboard (planned) | Integrates Pixhawk and Jetson; verify exact carrier compatibility, Ethernet topology and connectors |
| Companion computer | NVIDIA Jetson Orin Nano 8GB or Orin NX (final model TBD) | RTSP ingestion, object detection/tracking, onboard autonomy |
| Camera | SIYI R1M | 1080p Ethernet IP camera; RTSP video; **12 V DC, 3 W** |
| Airborne radio | Microhard pMDDL900-ENC | Primary 902–928 MHz IP data link for video, telemetry and metadata |
| Airborne antennas | 2 × existing 900 MHz half-wave dipoles, 3 dBi (candidate) | Two radio antenna ports; confirm connector, matching, positioning and regulatory approval |
| GPS | Holybro Micro M10 GPS (planned) | Positioning for flight controller |
| Main battery | 4S 5000 mAh LiPo (planned) | Propulsion and source for suitably protected/regulated accessory rails |
| Camera regulator | Regulated 12 V converter (planned) | Supplies R1M from 4S battery; include power margin and filtering |
| Other power | Proper Pixhawk power module, Jetson supply, radio supply, fuses/distribution | Separate verified voltage/current paths; no direct 4S connection to 12 V-only camera |

### Camera cable — supplier-confirmed

- The R1M **does not include an Ethernet-to-RJ45 cable or adapter**.
- Supplied cable length: **600 mm**.
- Supplied connectors: **MX1.25 6-pin** on one end and **JST 1.25 8-pin** on the other.
- SIYI/supplier confirmed **RTSP over a standard third-party Ethernet network**, without HM30, MK15, or MK15E.
- The supplier offered a **wiring diagram**; obtain it before making the custom Ethernet/RJ45 and 12 V/GND harness.
- Preserve Ethernet pair integrity, identify connector pin 1 and signal polarity, provide strain relief, and **never apply 12 V to Ethernet signal pins**.

## 4. Ground-station hardware

| Subsystem | Hardware | Function |
|---|---|---|
| Ground radio | Microhard pMDDL900-ENC | Wireless peer to aircraft radio |
| Ground antennas | 2 × existing 900 MHz half-wave dipoles, 3 dBi (candidate) | MIMO antenna pair; regulatory compatibility pending |
| Local computer | Raspberry Pi CM4 + compatible carrier | MAVLink ground services, RTSP viewer, detection overlays, networking |
| WAN backhaul | Starlink | Optional remote access, upload, fleet services; **not part of the air-to-ground RF hop** |
| Ground power | Dedicated regulated **12 V DC supply** for enclosed Microhard, sized against verified maximum draw | Use radio's documented power input and correct mating connector; power CM4 and Starlink separately or through a properly engineered distribution system |

The ground Microhard is **not powered by ordinary Ethernet from the CM4**. If passive PoE is considered, verify the precise Microhard model, voltage, injector pinout and compatibility first.

## 5. Data paths

| Data | Source | Processing | Destination |
|---|---|---|---|
| Flight telemetry / commands | Pixhawk 6X / ground control | MAVLink routed via supported Pixhawk–Jetson interface and onboard IP network | Microhard link ↔ CM4/GCS |
| Live video | SIYI R1M | Compressed RTSP stream over Ethernet | Jetson locally and, when link allows, CM4 over Microhard |
| Object detections | Jetson | Lightweight detector + tracker; class, confidence, boxes, IDs, timestamps | CM4/operator UI over Microhard; optionally server via Starlink |
| Remote analytics | Ground station | Logging, dashboards, optional heavier inference | Server/cloud via Starlink |
| Link-loss behavior | Jetson and Pixhawk | Jetson continues local perception; Pixhawk executes independently configured failsafes | Onboard operation, subject to verified mission design |

**Priority:** Safety-relevant control/telemetry must not be starved by the video stream. Validate QoS/traffic shaping and the camera's adjustable live bitrate. No link can guarantee continuous 1080p at maximum range.

## 6. Radio and antenna decision

- **Current preferred candidate:** two **Microhard pMDDL900-ENC** enclosed radios, replacing the earlier pMDDL2450-ENC 2.4 GHz proposal.
- Existing RFD900x inventory: **one 2.1 dBi straight quarter-wave monopole, one 2.1 dBi right-angle quarter-wave antenna, and four 3 dBi half-wave dipoles**.
- Proposed allocation: **two 3 dBi dipoles per Microhard**; keep quarter-wave antennas as spares.
- Verify that the specific antennas have compatible RP-SMA mating connectors, 50 Ω impedance, 902–928 MHz performance, suitable mounting/polarization and **authorization under the Microhard radio's FCC certification**. Matching frequency and gain alone do not establish regulatory approval.
- The previously supplied specifications listing **U.FL antenna connectors, 116-pin SMT connector, 3.3 V/4.2 V rails and ~7 g mass refer to the bare OEM module**, **not** the enclosed unit. Use the enclosed-unit manual for actual power, mass, connector and environmental specifications.
- The three purchased **RFD900x radio units are not used in this primary architecture**; only their detachable antennas are proposed for reuse.

## 7. Object-detection approach

1. Jetson accesses the R1M's RTSP stream via the **onboard Ethernet network**, not via a CSI connector.
2. Run a lightweight detector (e.g., YOLO) and tracker locally; optimize with TensorRT and consider DeepStream for production.
3. Send timestamped detection metadata (bounding boxes, classes, confidence, tracking IDs) over the Microhard link.
4. Ground UI overlays metadata on the separately received video; synchronize by timestamps.
5. Optional server-side analytics can process recorded or relayed video, but **must not be required for onboard detection**.

## 8. Open integration and production checks

1. **Exact Jetson Baseboard:** Confirm the Holybro carrier revision, compatible Jetson module, Pixhawk interconnect, exposed Ethernet ports, integrated switch behavior, power requirements and thermal design. Add a lightweight Ethernet switch if needed.
2. **Pixhawk MAVLink path:** Confirm UART/CAN/Ethernet transport supported by the chosen carrier and flight firmware; do not assume Pixhawk Ethernet is already wired or enabled.
3. **Microhard enclosed-unit datasheet:** Confirm DC input, peak current, antenna connector, LAN/WAN bridging, network mode, mounting, fan/thermal behavior and vibration tolerance.
4. **Camera harness:** Obtain supplier's 6-pin/8-pin pinout; fabricate and validate Ethernet + separate 12 V power harness.
5. **Camera streaming:** Confirm R1M codec, RTSP bitrate control, number of concurrent RTSP clients and behavior with simultaneous Jetson and ground-station subscriptions.
6. **Antenna approval:** Confirm existing RFD dipole model numbers are permitted with the pMDDL900-ENC; check legal RF power/EIRP configuration.
7. **Bandwidth and latency:** Measure simultaneous MAVLink, RTSP, detection metadata, interference resilience and link-loss recovery across realistic operating conditions.
8. **Power and flight time:** Measure complete loaded aircraft current draw, center of gravity, thermal performance and return-flight reserve; X500 battery endurance can limit practical mission radius before radio range.
9. **Safety/regulatory:** Configure and test Pixhawk failsafes independently of Jetson and the radio; follow applicable FAA operating limits and obtain any required authorization for BVLOS operations.

## 9. Design summary

**Camera → onboard Ethernet network ← Jetson (local detection)**  
**Pixhawk ↔ Jetson/carrier ↔ onboard Ethernet network ↔ airborne Microhard pMDDL900**  
**900 MHz wireless link ↔ ground Microhard ↔ CM4 ↔ optional Starlink/cloud**

This design prioritizes **onboard perception, a single shared IP video stream where supported, lightweight detection metadata, and safe operation during communications loss**. Radio choice, antenna authorization, Ethernet topology and power interfaces remain subject to final hardware verification.
