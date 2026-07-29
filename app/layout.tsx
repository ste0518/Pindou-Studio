import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拼豆工坊｜拼豆图纸生成工具",
  description: "在浏览器本地将图片转换为拼豆图纸，并统计色号与用量。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="icon" href="./favicon.svg" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
