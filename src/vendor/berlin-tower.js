/* Shared Berlin tower. Source: meta-uber-engineer/assets/berlin-tower.js. */
(() => {
  if (customElements.get('berlin-tower')) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  class BerlinTower extends HTMLElement {
    connectedCallback() {
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
      if (this.initialized) {
        if (!this.hasPlayed) this.observer?.observe(this.trigger);
        return;
      }
      this.initialized = true;
      shadow.innerHTML = `<style>
        :host { position: relative; display: inline-block; width: 30px; height: 45px; }
        [data-tower-trigger] { position: absolute; left: calc(50% - 1px); bottom: 6px; width: 2px; height: 2px; pointer-events: none; }
        button { display: block; width: 100%; height: 100%; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
        button:focus-visible { outline: none; border-image: url("/assets/ink-focus-0.svg?v=3#transparent") 33 fill / 9.35px / 6.65px round; }
        button > svg { display: block; width: 100%; height: 100%; overflow: visible; }
        svg { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: square; stroke-linejoin: miter; }
        [data-tower-base] { transform-origin: 32px 84px; }
        circle { fill: var(--tower-ball-color, #ff5a36); }
      </style><button type="button" aria-label="Replay tower animation"><svg viewBox="0 0 64 96" aria-hidden="true">
        <svg x="0" y="0" width="64" height="84" viewBox="0 0 64 84" style="overflow:hidden">
          <g data-tower-spire><line x1="32" y1="3" x2="32" y2="39"/><path d="M32 39 L25 84 M32 39 L39 84"/></g>
        </svg>
        <path data-tower-base d="M21 84 H43"/>
      </svg><span data-tower-trigger></span></button>`;
      const tower = shadow.querySelector('svg');
      let animations = [];
      const base = tower.querySelector('[data-tower-base]');
      const spire = tower.querySelector('[data-tower-spire]');
      let ball = null;
      const addBall = () => {
        if (ball) return ball;
        ball = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ball.setAttribute('data-tower-ball', '');
        ball.setAttribute('cx', '32');
        ball.setAttribute('cy', '29');
        ball.setAttribute('r', '10');
        tower.append(ball);
        return ball;
      };
      const setAssembled = () => {
        base.style.transform = 'scaleX(1)';
        spire.style.transform = 'translateY(0)';
        addBall();
        ball.style.transform = 'translateY(0)';
        ball.style.opacity = '1';
      };
      if (!reducedMotion.matches) {
        base.style.transform = 'scaleX(0)';
        spire.style.transform = 'translateY(84px)';
      } else {
        setAssembled();
      }
      const play = () => {
        animations.forEach((animation) => animation.cancel());
        animations = [];
        if (reducedMotion.matches) { setAssembled(); return; }
        this.hasPlayed = true;
        const run = this.animationRun = (this.animationRun ?? 0) + 1;
        ball?.remove();
        ball = null;
        base.style.transform = 'scaleX(0)';
        spire.style.transform = 'translateY(84px)';
        const animate = (selector, frames, options) => {
          const animation = tower.querySelector(selector).animate(frames, { fill: 'both', ...options });
          animations.push(animation);
          return animation;
        };
        const baseAnimation = animate('[data-tower-base]', [
          { transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }
        ], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
        animate('[data-tower-spire]', [
          { transform: 'translateY(84px)' }, { transform: 'translateY(0)' }
        ], { delay: 140, duration: 440, easing: 'cubic-bezier(.16,1,.3,1)' });
        void baseAnimation.finished.then(() => {
          if (!this.isConnected || reducedMotion.matches || this.animationRun !== run) return;
          const sphere = addBall();
          sphere.style.transform = 'translateY(-100px)';
          const animation = sphere.animate([
            { transform: 'translateY(-100px)', offset: 0, easing: 'cubic-bezier(.55,0,1,.6)' },
            { transform: 'translateY(0)', offset: .65, easing: 'cubic-bezier(0,.4,.4,1)' },
            { transform: 'translateY(-7px)', offset: .82, easing: 'cubic-bezier(.5,0,1,1)' },
            { transform: 'translateY(0)', offset: 1 }
          ], { fill: 'both', duration: 480 });
          animations.push(animation);
        }).catch(() => {});
      };

      this.observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        this.observer.disconnect();
        play();
      }, { threshold: 0 });
      this.trigger = shadow.querySelector('[data-tower-trigger]');
      this.observer.observe(this.trigger);
      shadow.querySelector('button').addEventListener('click', play);
      const stop = () => {
        this.animationRun = (this.animationRun ?? 0) + 1;
        animations.forEach((animation) => animation.cancel());
        animations = [];
        if (this.hasPlayed || reducedMotion.matches) setAssembled();
      };
      const motionChanged = () => { if (reducedMotion.matches) stop(); };
      reducedMotion.addEventListener('change', motionChanged);
      this.cleanup = () => { stop(); reducedMotion.removeEventListener('change', motionChanged); };
    }
    disconnectedCallback() {
      this.observer?.disconnect();
      this.cleanup?.();
    }
  }
  customElements.define('berlin-tower', BerlinTower);
})();
