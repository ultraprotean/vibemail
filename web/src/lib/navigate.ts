/** Full-page navigation (leaving the app for Google's consent screen). Wrapped so tests can stub it. */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
