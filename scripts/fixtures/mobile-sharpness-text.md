# Synthetic mobile text frame

`mobile-sharpness-text.h264` is a single synthetic Annex-B key frame generated
locally on 2026-09-20 for `test-mobile-video-sharpness.mjs`. It contains no device
capture, user content, network asset or font file. The pre-generated frame keeps
the regression test independent of H.264 **encoding** support: the product needs
decoding only.

- Source and decoded dimensions: 1080 × 2400.
- AVC profile from SPS: `avc1.42c033`.
- Exact length: 91,033 bytes.
- SHA-256: `9b36db846629511d7f5a2c52e7f71c967bbd7a390e8884237e384111c417fa2f`.
- Generated with Electron 43.1.1 `VideoEncoder`: requested codec `avc1.420033`,
  bitrate 4,000,000, framerate 60, realtime latency, Annex-B output, one key frame
  at timestamp 0. Only the encoded frame is stored.

The source was an opaque white 1080 × 2400 Canvas 2D. Its black synthetic text
was drawn as follows; the installed Arial font was used only for this local
generation and is not redistributed:

```js
for (let row = 0; row < 28; row++) {
  context.font = (16 + row % 5 * 4) + 'px Arial'
  context.fillText('ANDROID  EXPO GO  Letras finas  0123456789',
    32 + row % 3, 90 + row * 65)
}
```

The regression compares the production presentation with a high-quality image
reduction of the **same decoded frame**, rather than a font-dependent golden
PNG. It excludes white background pixels from its stroke error measurement.
Direct VideoFrame reduction reproduced RMSE 41.61/255; native-size staging then
image reduction produced 0 in the verified Windows NV12 path. The test accepts
small numerical differences, checks ink coverage, and also requires one ACK,
the expected source dimensions and no recovery.
