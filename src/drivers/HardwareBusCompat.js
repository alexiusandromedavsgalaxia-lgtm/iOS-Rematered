// Compatibility patch for the hardware bus API.
// Several virtual drivers use raiseInterrupt(), while HardwareBus exposes raiseIRQ().
// Keep both names working without duplicating IRQ queue logic.

import { HardwareBus } from './HardwareBus.js';

if (typeof HardwareBus.prototype.raiseInterrupt !== 'function') {
  HardwareBus.prototype.raiseInterrupt = function raiseInterrupt(irq, payload) {
    return this.raiseIRQ(irq, payload);
  };
}

export { HardwareBus };
export default HardwareBus;
