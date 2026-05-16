import type { Metadata } from "next";
import { TRPCProvider } from "@/components/TRPCProvider";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { DevBanner } from "@/components/DevBanner";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "HireOps Internal Portal",
  description: "Recruiter triage and pipeline operations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RootErrorBoundary>
          <TRPCProvider>
            {children}
            <DevBanner />
          </TRPCProvider>
        </RootErrorBoundary>
      </body>
    </html>
  );
}
