// The thumbs up / down control for Auto mix transitions. The player says when a transition can be
// rated ('mixrate' event, player.mixRating); this fades the control in for that window and out again
// when it ends or right after a click. The view is injected so the timing is testable without a DOM:
//   view = { mount(), reveal(), conceal(), unmount() }  (mount puts it in the layout, reveal fades it
//   in; conceal fades it out, unmount takes it out of the layout again)
export const FADE_MS = 220;

export function createMixRate(player, view, { reducedMotion = () => false, frame = requestAnimationFrame } = {}) {
  let mounted = false;
  let hideTimer = null;
  let revealing = 0;

  const show = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!mounted) { mounted = true; view.mount(); }
    // reduced motion: appear at once; otherwise let the layout settle for a frame so the fade runs
    if (reducedMotion()) { view.reveal(); return; }
    const token = ++revealing;
    frame(() => { if (token === revealing && mounted) view.reveal(); });
  };
  const hide = () => {
    if (!mounted) return;
    revealing++;
    view.conceal();
    clearTimeout(hideTimer);
    const done = () => { hideTimer = null; mounted = false; view.unmount(); };
    if (reducedMotion()) done();
    else hideTimer = setTimeout(done, FADE_MS);
  };

  const off = player.on('mixrate', rating => (rating ? show() : hide()));
  if (player.mixRating) show();
  return {
    rate(outcome) { return player.rateMix(outcome); },
    destroy() {
      off();
      revealing++; // a queued frame must not reveal a control that is going away
      // a fade-out that was running would never finish: take the control out of the layout now
      if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; mounted = false; view.unmount(); }
    },
  };
}
