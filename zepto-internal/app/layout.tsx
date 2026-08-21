import { Geist } from "next/font/google"

// Single CSS entry: app.css chains globals.css (theme paste target) then
// base.css (app plumbing) inside one Tailwind graph. Import order inside
// app.css is what makes the plumbing win over pasted themes.
import "./app.css"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

export const metadata = {
  title: "Zigma",
  description:
    "Zepto's internal image suite — composite product tiles and background removal.",
}

// Geist is the UI face, self-hosted at build by next/font (no runtime request to Google, so
// it works under the app's cross-origin-isolation headers). It publishes --font-app-sans, which
// base.css's --font-sans consumes ahead of the system fallback stack. The tile renderer's
// ZeptoNorms faces in public/fonts are separate and untouched by this. The old
// GoogleSans-Variable.ttf under app/fonts is no longer referenced.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-app-sans",
  display: "swap",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} antialiased font-sans`}
    >
      {/* The tweakcn live-preview <script> used to sit in a <head> block here.
          next.config.ts now sends Cross-Origin-Embedder-Policy: require-corp so
          the bg-remover WASM gets SharedArrayBuffer, and that header blocks the
          cross-origin script — it only produced a console error on every load. */}
      <body>
        <ThemeProvider>
          <TooltipProvider>
            {/* Figma-style fixed rail + content. min-w-0 on <main>: as a flex child it
                defaults to min-width:auto, so a wide product page would push the document
                wider than the viewport instead of shrinking to fit. */}
            <div className="flex min-h-dvh w-full">
              <AppSidebar />
              <main className="min-w-0 flex-1">{children}</main>
            </div>
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
