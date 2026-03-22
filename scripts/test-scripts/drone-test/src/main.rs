//! RDI Drone Test - Terminal-based MAVLink manual control for PX4 Gazebo.
//!
//! Connects to PX4 via UDP (localhost:14540) and sends MANUAL_CONTROL messages
//! based on keyboard input. Mirrors the agent/proxy architecture but runs
//! directly against local PX4 for testing.
//!
//! Usage: Start PX4 SITL with Gazebo, then run:
//!   cargo run
//!
//! Commander:  T: Takeoff | L: Land | R: RTL | G: Arm | X: Disarm
//! Controls:   W/S: pitch | A/D: roll | Q/E: yaw | Space: throttle up | C: throttle down | ESC: quit

use mavlink::common::{MavCmd, MavMessage};
use std::sync::atomic::{AtomicI16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const DEFAULT_MAVLINK_PORT: u16 = 18570;
const AXIS_DELTA: i16 = 200;
const THROTTLE_DELTA: i16 = 50;
const MIN_THROTTLE: i16 = 0;
const MAX_THROTTLE: i16 = 1000;
const NEUTRAL: i16 = 0;
const SEND_RATE_HZ: u64 = 25;
const DEFAULT_TAKEOFF_ALT_M: f32 = 2.5;

/// Commander commands sent from keyboard thread
#[derive(Clone, Copy, Debug)]
enum CommanderCmd {
    Arm,
    Disarm,
    Takeoff(f32),
    Land,
    ReturnToLaunch,
}

/// Shared control state (pitch, roll, yaw, throttle) - values -1000..1000 for axes, 0..1000 for throttle
struct ControlState {
    pitch:   AtomicI16,
    roll:    AtomicI16,
    yaw:     AtomicI16,
    throttle: AtomicI16,
}

impl ControlState {
    fn new() -> Self {
        Self {
            pitch:   AtomicI16::new(NEUTRAL),
            roll:    AtomicI16::new(NEUTRAL),
            yaw:     AtomicI16::new(NEUTRAL),
            throttle: AtomicI16::new(500), // Hover-ish for multicopter in Gazebo
        }
    }

    fn build_manual_control(&self, target: u8) -> mavlink::common::MANUAL_CONTROL_DATA {
        let mut data = mavlink::common::MANUAL_CONTROL_DATA::default();
        data.x = self.pitch.load(Ordering::Relaxed);
        data.y = self.roll.load(Ordering::Relaxed);
        data.z = self.throttle.load(Ordering::Relaxed);
        data.r = self.yaw.load(Ordering::Relaxed);
        data.target = target;
        data
    }
}

fn clamp_axis(v: i16) -> i16 {
    v.clamp(-1000, 1000)
}

fn clamp_throttle(v: i16) -> i16 {
    v.clamp(MIN_THROTTLE, MAX_THROTTLE)
}

fn build_command_long(
    command: MavCmd,
    param1: f32,
    param2: f32,
    param3: f32,
    param4: f32,
    param5: f32,
    param6: f32,
    param7: f32,
    target_system: u8,
    target_component: u8,
) -> mavlink::common::COMMAND_LONG_DATA {
    mavlink::common::COMMAND_LONG_DATA {
        param1,
        param2,
        param3,
        param4,
        param5,
        param6,
        param7,
        command,
        target_system,
        target_component,
        confirmation: 0,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let mavlink_port: u16 = std::env::var("RDI_MAVLINK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAVLINK_PORT);

    let addr = format!("udpout:127.0.0.1:{}", mavlink_port);
    tracing::info!("Connecting to PX4 at {} (start PX4 SITL + Gazebo first)", addr);

    let conn = mavlink::connect_async::<mavlink::common::MavMessage>(&addr).await?;

    let state = Arc::new(ControlState::new());
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<CommanderCmd>();

    // Keyboard input in a blocking thread
    let state_key = state.clone();
    let cmd_tx_key = cmd_tx.clone();
    std::thread::spawn(move || {
        crossterm::terminal::enable_raw_mode().expect("enable raw mode");
        let _restore = RestoreTerminal;

        loop {
            if crossterm::event::poll(Duration::from_millis(50)).unwrap() {
                if let Ok(crossterm::event::Event::Key(ev)) = crossterm::event::read() {
                    use crossterm::event::{KeyCode, KeyEventKind};
                    if ev.kind != KeyEventKind::Press {
                        continue;
                    }
                    match ev.code {
                        KeyCode::Esc => std::process::exit(0),
                        KeyCode::Char('t') | KeyCode::Char('T') => {
                            let _ = cmd_tx_key.send(CommanderCmd::Takeoff(DEFAULT_TAKEOFF_ALT_M));
                        }
                        KeyCode::Char('l') | KeyCode::Char('L') => {
                            let _ = cmd_tx_key.send(CommanderCmd::Land);
                        }
                        KeyCode::Char('r') | KeyCode::Char('R') => {
                            let _ = cmd_tx_key.send(CommanderCmd::ReturnToLaunch);
                        }
                        KeyCode::Char('g') | KeyCode::Char('G') => {
                            let _ = cmd_tx_key.send(CommanderCmd::Arm);
                        }
                        KeyCode::Char('x') | KeyCode::Char('X') => {
                            let _ = cmd_tx_key.send(CommanderCmd::Disarm);
                        }
                        KeyCode::Char('w') => {
                            state_key.pitch.fetch_add(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('s') => {
                            state_key.pitch.fetch_sub(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('a') => {
                            state_key.roll.fetch_sub(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('d') => {
                            state_key.roll.fetch_add(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('q') => {
                            state_key.yaw.fetch_sub(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('e') => {
                            state_key.yaw.fetch_add(AXIS_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char(' ') => {
                            state_key.throttle.fetch_add(THROTTLE_DELTA, Ordering::Relaxed);
                        }
                        KeyCode::Char('c') => {
                            state_key.throttle.fetch_sub(THROTTLE_DELTA, Ordering::Relaxed);
                        }
                        _ => {}
                    }
                    // Clamp after each change
                    let p = clamp_axis(state_key.pitch.load(Ordering::Relaxed));
                    let r = clamp_axis(state_key.roll.load(Ordering::Relaxed));
                    let y = clamp_axis(state_key.yaw.load(Ordering::Relaxed));
                    let t = clamp_throttle(state_key.throttle.load(Ordering::Relaxed));
                    state_key.pitch.store(p, Ordering::Relaxed);
                    state_key.roll.store(r, Ordering::Relaxed);
                    state_key.yaw.store(y, Ordering::Relaxed);
                    state_key.throttle.store(t, Ordering::Relaxed);
                }
            }
        }
    });

    // Print controls once
    println!("\n  Commander: T=Takeoff L=Land R=RTL G=Arm X=Disarm");
    println!("  W/S: pitch | A/D: roll | Q/E: yaw | Space: throttle up | C: throttle down | ESC: quit\n");

    let interval = Duration::from_millis(1000 / SEND_RATE_HZ);
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Target PX4 autopilot (system 1, component 1)
    const TARGET_SYSTEM: u8 = 1;
    const TARGET_COMPONENT: u8 = 1;

    loop {
        tick.tick().await;

        // Drain and send any pending commander commands
        while let Ok(cmd) = cmd_rx.try_recv() {
            let data = match cmd {
                CommanderCmd::Arm => build_command_long(
                    MavCmd::MAV_CMD_COMPONENT_ARM_DISARM,
                    1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                    TARGET_SYSTEM, TARGET_COMPONENT,
                ),
                CommanderCmd::Disarm => build_command_long(
                    MavCmd::MAV_CMD_COMPONENT_ARM_DISARM,
                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                    TARGET_SYSTEM, TARGET_COMPONENT,
                ),
                CommanderCmd::Takeoff(alt_m) => build_command_long(
                    MavCmd::MAV_CMD_NAV_TAKEOFF,
                    0.0, 0.0, 0.0, f32::NAN, f32::NAN, f32::NAN, alt_m,
                    TARGET_SYSTEM, TARGET_COMPONENT,
                ),
                CommanderCmd::Land => build_command_long(
                    MavCmd::MAV_CMD_NAV_LAND,
                    0.0, 0.0, 0.0, f32::NAN, f32::NAN, f32::NAN, f32::NAN,
                    TARGET_SYSTEM, TARGET_COMPONENT,
                ),
                CommanderCmd::ReturnToLaunch => build_command_long(
                    MavCmd::MAV_CMD_NAV_RETURN_TO_LAUNCH,
                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                    TARGET_SYSTEM, TARGET_COMPONENT,
                ),
            };
            let msg = MavMessage::COMMAND_LONG(data);
            if let Err(e) = conn.send(&mavlink::MavHeader::default(), &msg).await {
                tracing::warn!("commander send error: {}", e);
            } else {
                tracing::info!("commander: {:?}", cmd);
            }
        }

        let manual = state.build_manual_control(0);
        let msg = MavMessage::MANUAL_CONTROL(manual);

        if let Err(e) = conn.send(&mavlink::MavHeader::default(), &msg).await {
            tracing::warn!("send error: {}", e);
        }
    }
}

struct RestoreTerminal;

impl Drop for RestoreTerminal {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}
