//! The room clock, source side — a direct port of `Clock.swift` / `clock.ts`.
//!
//! Cristian's algorithm over the room WebSocket: send `t0`, the Durable Object
//! replies with `t1`, we stamp `t2`. Only probes near the fastest round trip
//! are believed (a slow round trip has more room to hide the path asymmetry
//! Cristian's algorithm cannot see). The estimate is stepped during the
//! opening burst and slewed afterwards.
//!
//! Time is monotonic milliseconds from a fixed `Instant`, never wall-clock, so
//! an NTP correction cannot yank the stream sideways.

use std::time::Instant;

const BURST: usize = 20;
const WINDOW: usize = 60;
const STEP_THRESHOLD_MS: f64 = 250.0;
const MAX_SLEW_MS: f64 = 4.0;
const RTT_ACCEPT_FACTOR: f64 = 1.5;
const RTT_ACCEPT_SLACK_MS: f64 = 2.0;

#[derive(Clone, Copy)]
struct Sample {
    rtt: f64,
    offset: f64,
}

pub struct RoomClock {
    origin: Instant,
    samples: Vec<Sample>,
    applied: f64,
    has_applied: bool,
}

impl RoomClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
            samples: Vec::with_capacity(WINDOW),
            applied: 0.0,
            has_applied: false,
        }
    }

    /// Local monotonic milliseconds — the source's `performance.now()`.
    pub fn local_now(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }

    pub fn offset(&self) -> f64 {
        self.applied
    }

    /// The fastest round trip in the window, ms — the source's telemetry rtt.
    pub fn min_rtt(&self) -> f64 {
        let m = self.samples.iter().map(|s| s.rtt).fold(f64::INFINITY, f64::min);
        if m.is_finite() { m } else { 0.0 }
    }

    /// Drop history after a reconnect — the path may be completely different.
    pub fn reset(&mut self) {
        self.samples.clear();
        self.has_applied = false;
    }

    /// Feed a pong. `t0` is our send stamp, `t1` the room clock at receipt.
    pub fn on_pong(&mut self, t0: f64, t1: f64) {
        let t2 = self.local_now();
        let rtt = t2 - t0;
        if rtt < 0.0 {
            return;
        }
        let offset = t1 - (t0 + t2) / 2.0;
        self.samples.push(Sample { rtt, offset });
        if self.samples.len() > WINDOW {
            self.samples.remove(0);
        }
        self.update();
    }

    fn accepted(&self) -> Vec<Sample> {
        if self.samples.is_empty() {
            return vec![];
        }
        let min_rtt = self.samples.iter().map(|s| s.rtt).fold(f64::INFINITY, f64::min);
        let limit = min_rtt * RTT_ACCEPT_FACTOR + RTT_ACCEPT_SLACK_MS;
        let kept: Vec<Sample> = self.samples.iter().copied().filter(|s| s.rtt <= limit).collect();
        if kept.is_empty() {
            vec![*self.samples.last().unwrap()]
        } else {
            kept
        }
    }

    fn update(&mut self) {
        let kept = self.accepted();
        if kept.is_empty() {
            return;
        }
        let target = median(kept.iter().map(|s| s.offset));

        // Still learning during the opening burst: step freely, nothing plays yet.
        if !self.has_applied || self.samples.len() <= BURST {
            self.applied = target;
            self.has_applied = true;
            return;
        }

        // Suspend/resume leaves the whole window describing a world that no
        // longer exists; if the recent probes agree against us, drop history.
        if self.samples.len() >= 4 {
            let recent = &self.samples[self.samples.len() - 4..];
            let above = recent.iter().all(|s| s.offset - self.applied > STEP_THRESHOLD_MS);
            let below = recent.iter().all(|s| self.applied - s.offset > STEP_THRESHOLD_MS);
            if above || below {
                let recent_vec = recent.to_vec();
                self.applied = median(recent_vec.iter().map(|s| s.offset));
                self.samples = recent_vec;
                return;
            }
        }

        let err = target - self.applied;
        if err.abs() > STEP_THRESHOLD_MS {
            self.applied = target;
        } else {
            self.applied += err.clamp(-MAX_SLEW_MS, MAX_SLEW_MS);
        }
    }

    /// Uncertainty in ms: the spread of the probes we chose to believe.
    pub fn uncertainty(&self) -> f64 {
        let kept = self.accepted();
        if kept.len() <= 1 {
            return 0.0;
        }
        let offs: Vec<f64> = kept.iter().map(|s| s.offset).collect();
        let lo = offs.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = offs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        (hi - lo) / 2.0
    }
}

fn median<I: Iterator<Item = f64>>(iter: I) -> f64 {
    let mut xs: Vec<f64> = iter.collect();
    if xs.is_empty() {
        return 0.0;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[mid]
    } else {
        (xs[mid - 1] + xs[mid]) / 2.0
    }
}
