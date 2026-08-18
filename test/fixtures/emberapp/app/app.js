import Application from '@ember/application';
import Resolver from 'ember-resolver';
import config from './config';

export default class AdminApplication extends Application {
  modulePrefix = config.modulePrefix;
  Resolver = Resolver;
}
