import './globals.css';

export const metadata = {
  title: 'Fieldnote | Interview Prep Kit',
  description: 'A focused workspace for turning a role into a confident interview plan.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
