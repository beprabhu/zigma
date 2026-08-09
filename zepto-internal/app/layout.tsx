import localFont from "next/font/local"

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

// Google Sans (self-hosted variable TTF: wght 400-700) is the UI face; --font-sans in
// base.css consumes this variable (with the system stack as fallback). The tile renderer's
// ZeptoNorms faces in public/fonts are separate and untouched by this.
const googleSans = localFont({
  src: "./fonts/GoogleSans-Variable.ttf",
  variable: "--font-app-sans",
  weight: "400 700",
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
      className={`${googleSans.variable} antialiased font-sans`}
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
