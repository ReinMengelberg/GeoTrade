import { Component } from '@angular/core';

import { AnalogWelcome } from '../../components/analog-welcome';

@Component({
  selector: 'app-home',
  imports: [AnalogWelcome],
  template: `
     <app-analog-welcome/>
  `,
})
export default class Home {}
