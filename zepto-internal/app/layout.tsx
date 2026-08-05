import { Lexend } from "next/font/google"

// Single CSS entry: app.css chains globals.css (theme paste target) then
// base.css (app plumbing) inside one Tailwind graph. Import order inside
// app.css is what makes the plumbing win over pasted themes.
import "./app.css"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

export const metadata = {
  title: "Zesku",
  description:
    "Zepto's internal image suite — composite product tiles and background removal.",
}

// Lexend is the UI face; --font-sans in globals.css consumes this variable
// (with the system stack as fallback).
const lexend = Lexend({ subsets: ["latin"], variable: "--font-lexend" })

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${lexend.variable} antialiased font-sans`}
    >
      {/* The tweakcn live-preview <script> used to sit in a <head> block here.
          next.config.ts now sends Cross-Origin-Embedder-Policy: require-corp so
          the bg-remover WASM gets SharedArrayBuffer, and that header blocks the
          cross-origin script — it only produced a console error on every load. */}
      <body>
        <ThemeProvider>
          {/* SidebarMenuButton's collapsed-mode tooltips need a Tooltip provider
              above the sidebar. */}
          <TooltipProvider>
            <SidebarProvider>
              <AppSidebar />
              {/* min-w-0: as a flex child the inset defaults to min-width:auto, so a
                  wide product page (the compositor's three panes) would push the
                  document wider than the viewport instead of shrinking to fit. */}
              <SidebarInset className="min-w-0">{children}</SidebarInset>
            </SidebarProvider>
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
