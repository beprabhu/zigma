// The Zigma mark — designer-supplied artwork (Frame 3.svg): five geometric lobes zig-zagging
// into a "Z". Plain SVG on transparent ground so it sits on any backdrop (rail, favicon,
// dock icon, about dialogs). Fixed brand colours by design — this does not follow the theme.
//
// The same shapes are redrawn in desktop/build (PIL) for the macOS .icns and in app/favicon.ico;
// change all three together or the identities drift.

export function ZigmaMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 50 50" fill="none" aria-hidden="true" {...props}>
      <path d="M25 32H32C35.866 32 39 35.134 39 39V39C39 42.866 35.866 46 32 46H25V32Z" fill="#1681F3" />
      <path d="M11 11C11 7.13401 14.134 4 18 4H25V18H18C14.134 18 11 14.866 11 11V11Z" fill="#F9105E" />
      <path d="M25 11C25 7.13401 28.134 4 32 4V4C35.866 4 39 7.13401 39 11V11C39 14.866 35.866 18 32 18H25V11Z" fill="#B223E7" />
      <path d="M11 39C11 35.134 14.134 32 18 32H25V39C25 42.866 21.866 46 18 46V46C14.134 46 11 42.866 11 39V39Z" fill="#6CCFDA" />
      <path d="M18 25C18 21.134 21.134 18 25 18V18C28.866 18 32 21.134 32 25V25C32 28.866 28.866 32 25 32V32C21.134 32 18 28.866 18 25V25Z" fill="#42B347" />
    </svg>
  );
}
