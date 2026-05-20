use serde::Serialize;
use std::{
    net::UdpSocket,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct ConnectionState {
    pub last_heartbeat_ms: Option<u128>,
    pub last_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub last_heartbeat_ms: Option<u128>,
    pub last_message: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time error")
        .as_millis()
}

pub fn start_udp_listener(state: Arc<Mutex<ConnectionState>>) {
    thread::spawn(move || {
        let socket = UdpSocket::bind("127.0.0.1:9000")
            .expect("Failed to bind UDP listener on 127.0.0.1:9000");

        println!("Recall Studio UDP listener running on 127.0.0.1:9000");

        let mut buffer = [0u8; 2048];

        loop {
            match socket.recv_from(&mut buffer) {
                Ok((size, addr)) => {
                    let message = String::from_utf8_lossy(&buffer[..size]).to_string();

                    println!("Received UDP message from {}: {}", addr, message);

                    if message.contains("/recall/heartbeat") {
                        let mut connection = state.lock().expect("Connection state lock failed");
                        connection.last_heartbeat_ms = Some(now_ms());
                        connection.last_message = Some(message);
                    }
                }
                Err(error) => {
                    eprintln!("UDP listener error: {}", error);
                }
            }
        }
    });
}

pub fn get_status(state: Arc<Mutex<ConnectionState>>) -> ConnectionStatus {
    let connection = state.lock().expect("Connection state lock failed");
    let current_time = now_ms();

    let connected = match connection.last_heartbeat_ms {
        Some(last_seen) => current_time.saturating_sub(last_seen) < 5_000,
        None => false,
    };

    ConnectionStatus {
        connected,
        last_heartbeat_ms: connection.last_heartbeat_ms,
        last_message: connection.last_message.clone(),
    }
}