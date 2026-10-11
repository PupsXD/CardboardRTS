import Phaser from "phaser";
import { BattleScene } from "./BattleScene";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#f6f1e4",
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: [BattleScene],
  render: { antialias: true },
});

// Для отладки и замеров из консоли браузера.
(window as unknown as { __game: Phaser.Game }).__game = game;
