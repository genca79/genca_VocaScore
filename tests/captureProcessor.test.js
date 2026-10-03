import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Il worklet di cattura gira nel thread audio del browser. Qui l'ambiente del worklet è simulato
 * (AudioWorkletProcessor, registerProcessor, currentTime) per verificarne la logica: decimazione per
 * l'analisi e audio a piena frequenza per il riascolto, sulla stessa linea del tempo.
 */
let Processor;
beforeAll(async () => {
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      constructor() {
        this.port = { posted: [], postMessage: (msg) => this.port.posted.push(msg), onmessage: null };
      }
    },
  );
  vi.stubGlobal('registerProcessor', (_, cls) => (Processor = cls));
  vi.stubGlobal('currentTime', 1.25);
  await import('../src/audio/captureProcessor.js');
});

function run(blocks, factor = 3) {
  const p = new Processor({ processorOptions: { factor } });
  for (const block of blocks) p.process([[Float32Array.from(block)]]);
  p.port.onmessage({ data: 'stop' });
  const of = (type) => p.port.posted.filter((m) => m.type === type).flatMap((m) => [...m.samples]);
  return { p, data: of('data'), raw: of('raw'), posted: p.port.posted };
}

describe('captureProcessor (worklet di cattura)', () => {
  it('voce originale a piena frequenza in PCM 16 bit, con saturazione', () => {
    const { raw } = run([[0, 0.5, -0.5, 1, -1, 2]]);
    expect(raw).toEqual([0, 16384, -16384, 32767, -32768, 32767]);
  });

  it('analisi decimata (media di `factor` campioni) sulla stessa linea del tempo', () => {
    const { data, raw } = run([[0.3, 0.3, 0.3, 0.6, 0.6, 0.6], [0.9, 0.9, 0.9]]);
    expect(data.map((v) => +v.toFixed(6))).toEqual([0.3, 0.6, 0.9]);
    expect(raw).toHaveLength(data.length * 3);
  });

  it('allo stop: blocchi residui consegnati, poi "end"; istante del primo campione all’avvio', () => {
    const { posted } = run([[0.1, 0.1, 0.1]]);
    expect(posted[0]).toEqual({ type: 'start', time: 1.25 });
    expect(posted.at(-1)).toEqual({ type: 'end' });
    expect(posted.some((m) => m.type === 'raw')).toBe(true);
  });

  it('blocchi lunghi: nessun campione perso a cavallo dei blocchi interni', () => {
    const n = 40000; // più di un blocco interno (16384) per l'audio originale
    const { raw } = run([Array.from({ length: n }, (_, i) => ((i % 100) - 50) / 100)]);
    expect(raw).toHaveLength(n);
    expect(raw[16384]).toBe(Math.round((((16384 % 100) - 50) / 100) * ((16384 % 100) - 50 < 0 ? 32768 : 32767)));
  });
});
