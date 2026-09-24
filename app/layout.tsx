import { ClerkProvider } from '@clerk/nextjs';
import "./globals.css";
import type { Metadata } from "next";
import { UserProvider } from '@/context/user-context';

export const metadata: Metadata = {
  title: "TestIt — AI testing that keeps up with you",
  description: "TestIt analyzes GitHub repository code, creates reviewable browser tests, and helps teams inspect failures.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body style={{ margin: 0, padding: 0 }}>
          <UserProvider>{children}</UserProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
