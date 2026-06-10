// Simple WebSocket client with event emitter pattern
export class Network {
  constructor() {
    this._ws       = null;
    this._handlers = {};
    this._queue    = [];
    this.connected = false;
    this.id        = null;
  }

  connect(url) {
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      this.connected = true;
      this._queue.forEach(m => this._ws.send(m));
      this._queue = [];
    };

    this._ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const h = this._handlers[msg.type];
      if (h) h(msg);
    };

    this._ws.onclose = () => {
      this.connected = false;
      // attempt reconnect after 3 s
      setTimeout(() => this.connect(url), 3000);
    };

    this._ws.onerror = () => {};
  }

  on(type, handler) {
    this._handlers[type] = handler;
  }

  send(msg) {
    const str = JSON.stringify(msg);
    if (this.connected && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(str);
    } else {
      this._queue.push(str);
    }
  }
}
