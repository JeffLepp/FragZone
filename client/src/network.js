// Simple WebSocket client with event emitter pattern
export class Network {
  constructor() {
    this._ws       = null;
    this._handlers = {};
    this._statusHandler = null;
    this._retryTimer    = null;
    this.connected = false;
    this.id        = null;
  }

  connect(url) {
    // Tear down any previous socket and pending retry so repeated connect()
    // calls (e.g. clicking ENTER FRAG again after a failure) can't stack
    // parallel reconnect loops that each emit their own 'open'.
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    if (this._ws) {
      this._ws.onopen = this._ws.onmessage = this._ws.onclose = this._ws.onerror = null;
      try { this._ws.close(); } catch { /* already closed */ }
      this.connected = false;
    }

    this._emitStatus('connecting', { url });
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      this.connected = true;
      this._emitStatus('open', { url });
    };

    this._ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const h = this._handlers[msg.type];
      if (h) h(msg);
    };

    this._ws.onclose = () => {
      this.connected = false;
      this._emitStatus('closed', { url });
      // attempt reconnect after 3 s
      this._retryTimer = setTimeout(() => {
        this._emitStatus('reconnecting', { url });
        this.connect(url);
      }, 3000);
    };

    this._ws.onerror = () => {
      this._emitStatus('error', { url });
    };
  }

  on(type, handler) {
    this._handlers[type] = handler;
  }

  onStatus(handler) {
    this._statusHandler = handler;
  }

  _emitStatus(type, detail = {}) {
    if (this._statusHandler) this._statusHandler(type, detail);
  }

  send(msg) {
    // Drop messages while disconnected: the server forgets the player when the
    // socket dies, so anything sent during an outage is stale by the time we
    // reconnect (the 'open' status handler re-joins from scratch instead).
    if (this.connected && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }
}
