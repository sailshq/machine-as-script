/**
 * Module dependencies
 */

var util = require('util');
var _ = require('lodash');
var program = require('commander');
var chalk = require('chalk');
var yargs = require('yargs');
var Machine = require('machine');
var rttc = require('rttc');



/**
 *
 * @param  {Dictionary|Machine} opts
 *         @property {Dictionary|Machine} opts.machine
 *         @property {Array} opts.args
 *         @property {Array} opts.envVarNamespace
 *         (see readme for more information)
 *
 * @return {Machine}     [a machine instance]
 */
module.exports = function runMachineAsScript(opts){

  opts = opts||{};

  // Use either `opts` or `opts.machine` as the machine definition
  // If `opts.machine` is truthy, we'll use that as the machine definition.
  // Otherwise, we'll understand the entire `opts` dictionary to be the machine
  // definition.
  var machineDef;
  if (!opts.machine) {
    machineDef = opts;
  }
  else {
    machineDef = opts.machine;
    delete opts.machine;
  }

  // Tolerate if no machine was provided (this is just for backwards compatibility-- should be deprecated.)
  machineDef = machineDef || {};

  // Set up namespace for environment variables.
  var envVarNamespace = '___';
  if (_.isString(opts.envVarNamespace)) {
    envVarNamespace = opts.envVarNamespace;
  }

  // `Machine.build()` tolerates:
  //   • machine definitions
  //   • already-instantiated ("wet") machine instances (just passes them through)
  //   • naked functions (builds them into an anonymous machine automatically.  For convenience and quick prototyping)

  // But since we're modifying the machine definition here...
  // (TODO: consider moving this into machine runner-- but need to do that _carefully_-- there's complexities in there)
  // we need to duck-type the provided machine to determine whether or not it is an already-instantiated machine or not.
  // If it is, use as-is. Otherwise, use the definition to build a new machine.
  // (checks new `isWetMachine` property, but also the function name for backwards compatibility)
  var wetMachine;
  if ( machineDef.isWetMachine || machineDef.name==='_callableMachineWrapper') {
    wetMachine = machineDef;
  }
  else {
    wetMachine = Machine.build(_.extend({
      identity: machineDef.identity || (machineDef.friendlyName ? _.kebabCase(machineDef.friendlyName) : 'anonymous-machine-as-script'),
      inputs: {},
      exits: {
        success: {
          description: 'Done.'
        },
        error: {
          description: 'Unexpected error occurred.'
        }
      },
      fn: function (inputs, exits){
        exits.error(new Error('Not implemented yet! (This is a default `fn` injected by `machine-as-script`.)'));
      }
    },machineDef));
  }


  // Configure CLI usage helptext and set up commander
  program.usage('[options]');

  // Keep track of shortcuts used (e.g. can't have a "-p" option mean two different things at once)
  var shortcutsSoFar = [];

  // Loop over each input and set up command line opts for usage docs generated by commander.
  _.each(wetMachine.inputs, function (inputDef, inputName) {

    // Handle `--` flags
    var opt = '--'+inputName;

    // Handle `-` shortcuts
    var optShortcut = (function (){
      var _shortcut = '-'+inputName[0];
      // If shortcut flag already exists using the same letter, don't provide a shortcut for this option.
      if (_.contains(shortcutsSoFar, _shortcut)) return;
      // Otherwise, keep track of the shortcut so we don't inadvertently use it again.
      shortcutsSoFar.push(_shortcut);
      return _shortcut;
    })();
    var optDescription = (function determineOptDescription(){
      var _optDescription = inputDef.description || inputDef.friendlyName || '';
      return (_optDescription[0]||'').toLowerCase() + _optDescription.slice(1);
    })();

    // Call out to commander and apply usage
    var optUsage = (function (){
      if (optShortcut){
        return util.format('%s, %s', optShortcut, opt);
      }
      return util.format('%s', opt);
    })();
    if (optDescription) {
      program.option(optUsage, optDescription);
    }
    else {
      program.option(optUsage);
    }

  });
  program.parse(process.argv);


  // Notice we DON'T tolerate unknown options
  // If we wnated to, we'd have to have something like the following:
  // .unknownOption = function NOOP(){};


  // Build inputs from CLI options and args
  var inputConfiguration = {};

  // Supply CLI options
  _.extend(inputConfiguration, yargs.argv);
  delete inputConfiguration._;
  delete inputConfiguration.$0;

  // Supply environment variables
  _.each(wetMachine.inputs, function (inputDef, inputName){
    var envVarData = process.env[envVarNamespace + inputName];
    if (_.isUndefined(envVarData)) {
      return;
    }

    // If environment variable exists, we'll grab its value and
    // supply it as configuration for this input.
    inputConfiguration[inputName] = envVarData;
  });

  // Include a special `args` input for convenience--
  // but note that this is an experimental feature that could change.
  if (_.isArray(yargs.argv._)) {
    inputConfiguration.args = yargs.argv._;
  }

  // Supply argv CLI arguments using special `args` notation
  if (_.isArray(opts.args)) {
    _.each(opts.args, function (inputName, i){
      inputConfiguration[inputName] = yargs.argv._[i];
    });
  }

  // Finally, loop through each of the input configurations and run `rttc.parseHuman()`.
  inputConfiguration = _.reduce(inputConfiguration, function (memo, val, inputName){

    // Skip special `args` input (unless there's actually an input named `args`.)
    var inputDef = wetMachine.inputs[inputName];
    if (!inputDef && inputName === 'args') {
      return memo;
    }
    if (!inputDef) {
      throw new Error('Unexpected error: received configuration for unknown input ('+inputName+')');
    }
    // Before using `rttc.parseHuman()`, ensure the value is a string
    // (yargs parses some things as numbers)
    val = val+'';
    memo[inputName] = rttc.parseHuman(val, rttc.infer(inputDef.example), true);
    return memo;
  }, {});

  // Set input values from CLI args/opts
  var liveMachine = wetMachine(inputConfiguration);

  // Set some default exit handlers
  liveMachine.setExits({
    error: function(err) {
      // console.error(chalk.red('Unexpected error occurred:\n'), err);
      console.log(chalk.red('Something went wrong:'));
      console.error(err.stack ? chalk.gray(err.stack) : err);
    },
    success: function(output) {

      // If output is expected, then log it.
      if (!_.isUndefined(output)) {
        try {
          if (
            !_.isUndefined(liveMachine.exits.success.example) ||
            _.isFunction(liveMachine.exits.success.getExample) ||
            !_.isUndefined(liveMachine.exits.success.like) ||
            !_.isUndefined(liveMachine.exits.success.itemOf)
          ) {
            // TODO: support json-encoded output vs colors
            console.log(util.inspect(output, {depth: null, colors: true}));
          }
        }
        catch (e) { /* fail silently if anything goes awry */ }
        return;
      }

      // Otherwise, log a generic message.
      console.log(chalk.green('OK.'));

    }
  });

  // Set a telltale property to allow `bin/machine-as-script` to be more
  // intelligent about catching wet machine instances which are already wrapped
  // in a call to machine-as-script.  Realistically, this rarely matters since
  // script modules don't normally export anything, but it's here just in case.
  liveMachine._telltale = 'machine-as-script';

  // Return the ready-to-exec machine.
  return liveMachine;

};
