export default function Footer() {
  return (
    <footer className="site-footer">
      <span>Kai Lani Bodywork & Wellness</span>
      <span>NC LMBT license no. 19862</span>
      <span>106 S Main St, Suite F, Mount Holly, NC 28120</span>
      <a href="tel:+19802242462">(980) 224-2462</a>
      <a href="mailto:appointments@kailanibodywork.com">appointments@kailanibodywork.com</a>
      <a href="https://www.instagram.com/kailani.bdywrk/" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
        Instagram
      </a>
    </footer>
  );
}
