import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jerebu Watch · IPU Alor Setar & Kangar",
  description: "Hourly Air Pollutant Index (IPU) for Alor Setar and Kangar from official DOE APIMS data",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
