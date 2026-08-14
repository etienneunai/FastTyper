import sys
import requests
import json
import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

# NOTE: Interfacing with Fcitx5 DBus requires an active Fcitx5 session.
# We will hook into org.fcitx.Fcitx5.InputMethod (or use Wayland input method protocol if preferred).
# This is a scaffolding skeleton for the DBus service.

LLAMA_SERVER_URL = "http://127.0.0.1:8808/v1/chat/completions"

def check_grammar(text):
    """Send text to the local llama-server for grammar correction."""
    schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "original": {"type": "string"},
                "replacement": {"type": "string"},
                "type": {"type": "string"}
            },
            "required": ["original", "replacement", "type"]
        }
    }
    
    payload = {
        "model": "qwen2.5-0.5b",
        "messages": [
            {"role": "system", "content": "You are a grammar correction assistant. Correct the text."},
            {"role": "user", "content": text}
        ],
        "response_format": {
            "type": "json_object",
            "schema": schema
        },
        "temperature": 0.1
    }
    
    try:
        resp = requests.post(LLAMA_SERVER_URL, json=payload, timeout=2.0)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        print(f"Error connecting to llama-server: {e}")
    return None

def main():
    print("Starting Grammar Proxy for Fcitx5...")
    DBusGMainLoop(set_as_default=True)
    session_bus = dbus.SessionBus()
    
    # Placeholder: Connect to Fcitx5 DBus signals or method calls here
    # Example: session_bus.add_signal_receiver(on_input, signal_name='SomeFcitxSignal', ...)
    
    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        print("Exiting...")

if __name__ == '__main__':
    main()
