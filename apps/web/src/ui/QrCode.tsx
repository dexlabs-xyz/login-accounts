/**
 * QR code for a deposit address, drawn in Figma's style: white dots on dark, rounded corner squares.
 * Encoded with uqr (unjs, MIT, no dependencies; pinned; Gold approved 12 Nov). Medium error correction.
 */
import { useMemo } from 'react';
import { encode } from 'uqr';

const POSITION = 2; // uqr's QrCodeDataType.Position: the three corner squares

export function QrCode({ value, size = 221 }: { value: string; size?: number }) {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 0 }), [value]);
  const n = qr.size;
  const dots: React.ReactNode[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.data[y]![x] || qr.types[y]![x] === POSITION) continue;
      dots.push(<circle key={`${x}.${y}`} cx={x + 0.5} cy={y + 0.5} r={0.42} />);
    }
  }
  // The three corner squares: a rounded 7×7 ring with a rounded 3×3 centre.
  const corners = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ].map(([x, y]) => (
    <g key={`${x}.${y}`}>
      <rect x={x! + 0.5} y={y! + 0.5} width={6} height={6} rx={1.6} fill="none" stroke="currentColor" strokeWidth={1} />
      <rect x={x! + 2} y={y! + 2} width={3} height={3} rx={0.8} />
    </g>
  ));
  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={`QR code of the address ${value}`}
      fill="currentColor"
      shapeRendering="geometricPrecision"
    >
      {corners}
      {dots}
    </svg>
  );
}
