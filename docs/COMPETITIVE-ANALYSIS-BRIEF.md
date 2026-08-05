# RDI — Competitive analysis brief

**Platform name:** **RDI** (Remote Drone Infrastructure)  
**Working product surface:** browser **Console** (React) + cloud control plane + field **relay** (Raspberry Pi)  
**Document purpose:** One-pager for head-to-head comparison vs cloud-drone / remote-ops platforms (FlytBase, UgCS, DJI FlightHub, Cloud Ground Control, VOTIX, etc.).

---

## Elevator summary

RDI is a **cloud-orchestrated, browser-native remote piloting stack**. Operators manage relays and connections in a web console; live stick/command traffic and (planned) video run over **WebRTC** between the browser and a field **relay** (Pi), with an optional **long-range radio hop** (e.g. RFD900 / MAVLink TUNNEL) to the aircraft. It is built for **human-in-the-loop** remote control over cellular/internet to a mothership/relay, not as a closed DJI-only fleet SaaS or a primarily DiaB scheduling product.

---

## Answers to evaluation axes

### Hardware compatibility

| Aspect | RDI position |
|--------|----------------|
| **Ecosystem stance** | **Open / companion-oriented**, not a DJI-closed stack. |
| **Autopilot path** | Designed around **MAVLink** (PX4-class / ArduPilot-class) via serial and radio bridges—not vendor lock to one OEM app. |
| **Field hardware today** | **Raspberry Pi CM4**-class relay (e.g. Holybro CM4 baseboard + Pixhawk companion path); air/ground **telemetry radios** (e.g. RFD900); FTDI/USB ground agents for RF lab/ops. |
| **DJI** | **Not** a first-class FlightHub-style DJI ecosystem product. DJI aircraft would need an intentional bridge/companion strategy—not the current core path. |
| **Custom / modular payloads** | Architecture direction: **logical control actions** in the console + **vehicle-side capability/profile** mapping (jerry-rigged arms, aux channels, etc.)—universal transport, airframe-specific effects. |

**Vs competitors (framing):** Closer to “hardware-agnostic MAVLink/companion” platforms (FlytBase / UgCS class) than to DJI FlightHub 2’s closed fleet. Less mature as a polished multi-OEM marketplace than incumbents; stronger emphasis on **relay + RF last mile** you control.

### Architecture

| Aspect | RDI position |
|--------|----------------|
| **Operator client** | **Native cloud/browser** — React console, Cognito auth, no required desktop “Commander” install for the pilot UI. |
| **Control plane** | AWS **API Gateway + Lambda + DynamoDB + Cognito** (sessions, relays, user profiles). |
| **Data plane** | **WebRTC** peer connection browser ↔ Pi; **Amazon Kinesis Video Streams used for signaling only** (not the media/command pipe). |
| **Field node** | Always-on **relay daemon** on Pi (`rdi-relay-daemon` + per-session WebRTC workers); outbound-friendly (signaling out, then P2P/relayed WebRTC). |
| **Optional RF segment** | Browser ↔ Pi (WebRTC) ↔ **radio** ↔ ground/air agent — for beyond-Wi‑Fi mothership↔drone links. |
| **Local install** | Not required for pilots. Ground radio echo/agent scripts are **optional ops tools**, not the primary GCS. |

**Vs competitors (framing):** Aligns with **cloud/browser** players (e.g. Cloud Ground Control / VOTIX-style), not UgCS-style thick client as the center of gravity—while still owning a **physical relay** you deploy.

### Latency optimization

| Aspect | RDI position |
|--------|----------------|
| **Command path** | **WebRTC data channel** (unordered/low-retransmit style for stick/CTRL), not HLS/DASH (~20–40s). |
| **Signaling** | KVS WebRTC signaling; media/commands after ICE are **not** hairpinned through KVS as a byte pipe. |
| **Link tests** | In-console **live ping** (relay-only vs full radio path) and CTRL round-trips for ops visibility. |
| **Radio last mile** | Adds RF/UART latency on top of WebRTC; MAVLink TUNNEL payloads are size-constrained (compact CTRL frames). |
| **Video** | Architecture includes WebRTC media tracks; treat full production video SLAs as **roadmap/maturity** vs command path which is active. |

**Vs competitors (framing):** Same technical family as “sub‑second WebRTC remote ops” claims—not RTMP/HLS viewing latency. Exact ms depends on cellular, TURN/ICE, and whether the radio hop is in path.

### Autonomy depth

| Aspect | RDI position |
|--------|----------------|
| **Primary mode** | **Human-in-the-loop remote operator** — live keybinds/gamepad → logical actions → CTRL over data channel (and optional radio). |
| **DiaB / fleet scheduling** | **Not** the current product center (no Dock/DiaB mission scheduler as the headline). |
| **Session model** | Relays parent **connections** (one WebRTC session per aircraft link); multi-session per Pi supported via daemon workers. |
| **Per-aircraft controls** | **Per-connection keybinds** (operator prefs on user profile); direction toward vehicle **capability menus** for modular payloads. |

**Vs competitors (framing):** Compete on **remote stick/command reach + relay/RF**, not on automated Drone-in-a-Box mission factories (FlytBase/DJI dock narratives).

---

## Specialized / differentiating features (current emphasis)

1. **Relay-centric console** — Register/claim Pi relays; connections hang under relays; cloud owns lifecycle, field owns real-time peer.  
2. **WebRTC-native command path** — Pilot browser talks to the field node directly after signaling (KVS matchmaker only).  
3. **Optional long-range radio hop** — Full-path ping and control frames over shared serial/MAVLink TUNNEL router on the Pi.  
4. **Operator UX for live control** — Connection “control deck” (live input, relay vs radio toggle, live RTT), setup gear for identity/TTL and per-drone binds.  
5. **Open MAVLink/companion bias** — Built for custom/Pixhawk-class stacks and improvised payloads via profiles, not a single OEM store.

---

## Target use (how to describe industry)

Position as:

- **Remote / BVLOS-style human piloting** via internet to a **field mothership/relay**, then local or radio link to the aircraft.  
- **Defense-adjacent, public-safety, research, and custom industrial** stacks where airframes are **mixed or jerry-rigged** and operators need **their own** GCS-in-browser—not only DJI Dock fleets.  
- **Not** primarily “enterprise DiaB automated inspection SaaS” in the current build.

---

## Honest maturity notes (for accurate comps)

Use these so comparisons stay fair:

| Strong / intentional | Early / directional |
|----------------------|---------------------|
| Cloud control plane + browser console | Broad OEM marketplace / DJI parity |
| WebRTC session + CTRL/ping ops | Production video parity with top streaming GCS claims |
| Pi relay + radio path for last mile | Rich autonomy / DiaB scheduling |
| Per-connection operator control maps | Full vehicle capability auto-discovery in field |

---

## One-line positioning for a comparison table

> **RDI** is a **browser-native, AWS-backed remote piloting platform** that connects operators over **WebRTC** to **customer-owned Pi relays**, with optional **MAVLink/radio last-mile**, optimized for **human-in-the-loop** control of **open/custom airframes**—not a closed DJI FlightHub ecosystem or a DiaB scheduling suite.

---

## Suggested comparison columns

When building the head-to-head table, score RDI on:

1. Browser-only pilot UI vs desktop install  
2. DJI-only vs MAVLink/custom hardware  
3. WebRTC command/video vs HLS/RTMP viewing  
4. Customer-owned relay/radio last mile vs pure cloud-to-dock  
5. HITL stick/custom actions vs DiaB autonomy depth  
6. Multi-connection-per-relay model  

---

## Roadmap questions (locked answers)

| Question | RDI answer | Implication |
|----------|------------|-------------|
| **Pilot interaction model?** | **Primary: gamepad / keyboard (and future stick) over the internet** into the connection control deck. Point-and-click **browser waypoints are secondary**—useful later as assisted modes, not the v1 identity. | Invest in CTRL pipe, binds, capability profiles, link health (ping/RTT). Do not pivot the UX to “draw a polygon and walk away.” |
| **Near-term priority: production video vs MAVLink/control depth?** | **Near-term priority: deepen the control plane**—reliable CTRL, per-connection maps, vehicle capability pull, MAVLink/aux execution on the relay/air agent. **Production glass-to-glass video is the next major workstream**, not a distraction from command, but **sequenced after** a trustworthy stick path on the same WebRTC peer. | Video ships on the **same WebRTC session** (media tracks), never by turning KVS into the media pipe or by RTMP/HLS for piloting. |

These answers protect the unfair advantages: RF last mile, open payloads, and true low-latency command pipes stay non-negotiable.

---

## Critical shortcomings → response plan (without compromising core advantages)

External critique is fair. The strategy is **close the gap where buyers require parity**, **refuse to chase DiaB as the product identity**, and **turn relay friction into a productized mothership appliance**.

### Non-negotiables (do not sacrifice)

1. **Tactical independence / RF last mile** — Pi mothership + RFD900/MAVLink TUNNEL into cellular-dead zones.  
2. **Open / jerry-rigged payload flexibility** — logical actions in browser → airframe-specific maps.  
3. **WebRTC data channel as stick pipe** — unordered/low-retransmit command path; KVS remains **signaling only**.

Anything below must reinforce these, not replace them with “click buy DJI dock.”

---

### 1. Production video maturity

**Weakness:** Competitors ship rock-solid low-latency video; RDI’s KVS use is signaling-only and payload video is early.

**Do not do:** Make KVS (or RTMP/HLS) the piloting video path. That reintroduces multi-second lag and undermines the command-pipe story.

**Do this instead:**

| Phase | Outcome | Keeps advantage? |
|-------|---------|------------------|
| **V0 (now)** | Command deck + ping/CTRL proven on WebRTC data channel | Yes — command-first honesty |
| **V1** | One H.264 (or agreed codec) **media track on the existing WebRTC peer** from Pi camera / FC stream bridge; HUD picture-in-picture in the connection window | Yes — same peer as sticks |
| **V2** | Ops polish: reconnect, adaptive bitrate under cellular, optional secondary “review” recording to S3 **offline from the pilot loop** | Yes — recording ≠ piloting path |
| **V3** | Multi-camera / thermal as extra tracks or switchable sources still on WebRTC | Yes |

**Positioning line:** *Video rides the same WebRTC session as sticks; we refuse glass-to-glass architectures that trade pilot latency for CDN convenience.*

**Buyer honesty:** Until V1 ships, say “command-grade remote link; production video on roadmap on the same pipe”—do not claim FlightHub video parity.

---

### 2. Missing the DiaB / automation hype train

**Weakness:** Industry spend is on docks and hands-off patrols; RDI is HITL-centric.

**Do not do:** Rebuild RDI as a Dock SaaS. That burns the mothership/RF differentiation and loses to DJI/FlytBase on their home field.

**Do this instead:**

| Move | Detail |
|------|--------|
| **Own the wedge** | Sell **tactical HITL reach** (ridge-line mothership → RF dead zones → custom airframes). DiaB buyers are a different ICP. |
| **Partner, don’t clone** | If a customer needs scheduled dock flights *and* RDI, integrate later as “autonomy plane elsewhere / RDI as emergency or custom-payload HITL”—not year-one scope. |
| **Assisted, not unmanned** | Optional later: browser waypoints / RTL / simple mission upload **as pilot aids** on MAVLink—still human-supervised, still over the same CTRL path. Explicitly **not** unattended facility patrols. |
| **Narrative** | “Hands-off docks win warehouses with perfect LTE. RDI wins when the network dies, the airframe is custom, or a human must stay in the loop.” |

**Positioning line:** *We skip the DiaB arms race on purpose; we are the remote stick for contested and custom air.*

---

### 3. Hardware deployment friction

**Weakness:** FlytBase/FlightHub feel like buy-drone-click-online; RDI needs Pi daemons, serial, radios.

**Do not do:** Remove the relay to “be more SaaS.” The relay **is** the unfair advantage.

**Do this instead — productize the mothership:**

| Move | Detail |
|------|--------|
| **Appliance image** | Factory / golden Pi image: daemon, radio env, claim-on-boot, health LEDs—minimize SSH for baseline ops (aligns with existing setup-GUI / factory-image plans). |
| **Claim UX** | Pairing code → console “relay online” in minutes; one path for CM4 + radio kit SKU. |
| **Opinionated kit** | Documented BOM: CM4 baseboard + radio + power—“RDI mothership kit”—sold or listed, not a bag of scripts. |
| **Guided bring-up** | Console checklist: claim → radio ping → control deck; fail closed with actionable errors. |
| **Who we sell to** | Teams that already accept field kits (defense-adjacent, PS, research). Non-technical “Amazon Dock” buyers stay non-ICP. |

**Positioning line:** *Deployment friction is real; we turn it into a single mothership appliance, not a pile of DIY repos—and that appliance is why we work where cellular GCS dies.*

---

## Integrated roadmap (next priorities)

Ordered to fix buyer-visible gaps **without** diluting strengths:

1. **Control depth (now → near)** — Stable CTRL; per-connection binds; capability/CAPS menu from vehicle or templates; MAVLink/aux execution on relay/air agent; unmapped-action honesty.  
2. **Mothership packaging (parallel)** — Image, claim, kit docs, guided ping/control checklist.  
3. **Production WebRTC video (next major)** — Camera → Pi → same peer media track → console HUD; metrics for glass-to-glass on cellular.  
4. **Assisted HITL (later)** — Waypoints/RTL as optional aids—not DiaB.  
5. **Explicit non-goals (near term)** — DJI FlightHub parity; unattended dock scheduling; KVS/RTMP as live pilot video.

```text
ICP: HITL + custom/RF reach
        │
        ├─► Command pipe + profiles     (advantage: stick + payloads)
        ├─► Mothership appliance        (fix friction, keep relay)
        ├─► WebRTC video on same peer   (fix video gap, keep architecture)
        └─► ✗ DiaB clone / ✗ OEM lock-in
```

---

## How to answer critics in one paragraph

RDI accepts three tradeoffs: we are not a one-click DJI dock, we are not a DiaB scheduler, and production video is catching up to the command path. In exchange we keep what cloud GCS stacks rarely own—**a field mothership with an RF last mile**, **open mapping for improvised payloads**, and a **WebRTC stick pipe** that does not pretend HLS is piloting. The plan is to **appliance-ize the relay**, **finish glass-to-glass on the same WebRTC session**, and **deepen MAVLink/custom controls for keyboard/gamepad operators**—not to abandon the wedge that makes RDI different.

---

*Internal reference: see `docs/architechure-master/ARCHITECTURE.md`, `docs/CONSOLE-CONTROLS-KEYBINDS.md`, relay-device radio docs.*
