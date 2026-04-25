import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"

const _geist = Geist({ subsets: ["latin"] })
const _geistMono = Geist_Mono({ subsets: ["latin"] })

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
}

export const metadata: Metadata = {
  title: "Setra",
  description: "Train with intent",
  applicationName: "Setra",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Setra",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-[env(safe-area-inset-bottom,0px)]">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
