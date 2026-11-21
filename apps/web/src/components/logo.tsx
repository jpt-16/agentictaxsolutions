/** The Pelloria mark: a P whose bowl is layered like the agents, with an amber dot for the human sign-off. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="flex-none">
      <rect width="512" height="512" rx="116" fill="#0C2A2E" />
      <g transform="translate(256 256) scale(1.3) translate(-262 -256)">
        <path d="M209 118a106 106 0 0 1 0 212" fill="none" stroke="#EAF6F4" strokeWidth="24" />
        <path d="M209 158a66 66 0 0 1 0 132" fill="none" stroke="#3CC4B5" strokeWidth="24" />
        <rect x="197" y="106" width="24" height="300" rx="12" fill="#EAF6F4" />
        <circle cx="243" cy="224" r="12" fill="#F5B84B" />
      </g>
    </svg>
  );
}
