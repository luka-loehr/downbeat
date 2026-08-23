import { useEffect, useRef } from "react";
import QRCode from "qrcode";

/** The join code as a QR, drawn in the panel palette rather than plain black. */
export function QR({ value, size = 208 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void QRCode.toCanvas(el, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#f2efe9ff", light: "#0f0e16ff" },
    });
  }, [value, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className="rounded-lg border border-line"
      style={{ width: size, height: size }}
    />
  );
}
