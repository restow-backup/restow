import * as React from "react";

import { QUIET_ZONE, encodeQr, qrSvgPath } from "@/lib/qr";
import { cn } from "@/lib/utils";

interface QrCodeProps {
  /** The text to encode, e.g. an `otpauth://` URI. */
  value: string;
  /** What the code is for, read out by screen readers. */
  label: string;
  className?: string;
}

/**
 * A scannable QR code, encoded in the browser. It stays dark on white in
 * both themes: cameras and authenticator apps expect that contrast.
 */
export function QrCode({ value, label, className }: QrCodeProps) {
  const { path, dimension } = React.useMemo(() => {
    const code = encodeQr(value);
    return { path: qrSvgPath(code), dimension: code.size + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dimension} ${dimension}`}
      shapeRendering="crispEdges"
      className={cn("block rounded-md", className)}
    >
      <rect width={dimension} height={dimension} className="fill-white" />
      <path d={path} className="fill-black" />
    </svg>
  );
}
