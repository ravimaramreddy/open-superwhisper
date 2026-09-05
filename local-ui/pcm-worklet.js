class DictationPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data.type !== "flush") return;
      this.finished = true;
      this.send();
      this.port.postMessage({ type: "flushed" });
    };
  }
  send() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: "samples", samples }, [samples.buffer]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.finished) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame];
      this.buffer[this.offset++] = mono / channels.length;
      if (this.offset === this.buffer.length) this.send();
    }
    return true;
  }
}
registerProcessor("dictation-pcm", DictationPCM);
