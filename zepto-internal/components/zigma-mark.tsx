// The Zigma mark — designer-supplied artwork (Frame 4.svg): a diagonal "Z" stroke between
// two rounded lobes. Plain SVG on transparent ground so it sits on any backdrop (rail,
// favicon, dock icon, about dialogs). Fixed brand colours by design — this does not follow
// the theme.
//
// The same shapes are rasterized (via headless Chrome) for the macOS .icns and app/favicon.ico;
// change all three together or the identities drift.

export function ZigmaMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 50 50" fill="none" aria-hidden="true" {...props}>
      <path d="M13 29.2026L31.3848 10.8179L38.6184 18.0515L20.2336 36.4363L13 29.2026Z" fill="#1681F3" />
      <path d="M24 28H26C32.6274 28 38 33.3726 38 40V42H24V28Z" fill="#42B347" />
      <path d="M12 7H26V21H24C17.3726 21 12 15.6274 12 9V7Z" fill="#F9105E" />
      <path d="M26 7H33C36.866 7 40 10.134 40 14V14C40 17.866 36.866 21 33 21H26V7Z" fill="#B223E7" />
      <path d="M10 35C10 31.134 13.134 28 17 28H24V42H17C13.134 42 10 38.866 10 35V35Z" fill="#6CCFDA" />
    </svg>
  );
}
