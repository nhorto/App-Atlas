import Component from '@glimmer/component';

export default class PowerCalendar extends Component {
  get weeks() {
    return this.args.weeks ?? [];
  }
}
