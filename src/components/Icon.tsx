import type { CSSProperties } from "react";

const paths = {
  plus: "M12 5v14M5 12h14",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  activity: "M2 12h4l3-8 6 16 3-8h4",
  send: "m22 2-7 20-4-9-9-4L22 2ZM22 2 11 13",
  cpu: "M7 7h10v10H7z M9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3 M4 4h16v16H4z",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M10 12h4",
  settings:
    "m9 3 1-2h4l1 2 2 1 2 0 2 3-1 2v3l1 2-2 3-2 0-2 1-1 2h-4l-1-2-2-1H5l-2-3 1-2V9L3 7l2-3h2l2-1Z M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  moon: "M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  arrowDown: "M12 3v18m-6-6 6 6 6-6",
  arrowUp: "M12 21V3m-6 6 6-6 6 6",
  arrowRight: "M4 12h16m-6-6 6 6-6 6",
  compare: "M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4",
  refresh:
    "M20 7v5h-5 M4 17v-5h5 M6 5a8 8 0 0 1 13 3l1 4M4 12l1 4a8 8 0 0 0 13 3",
  plug: "M8 2v5m8-5v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5",
  unplug: "m3 3 18 18M8 2v3m8-3v5M6 7h12v4a6 6 0 0 1-10 4M12 17v5",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 6 6",
  pause: "M8 5v14M16 5v14",
  play: "m7 4 14 8-14 8V4Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  download: "M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12M6 18 18 6",
  shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6L12 2Zm-4 10 3 3 5-6",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  copy: "M9 9h12v12H9z M15 5V3H3v12h2",
  bolt: "m13 2-9 12h7l-1 8 10-13h-8l1-7Z",
  circle: "M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 20,
  className = "",
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
