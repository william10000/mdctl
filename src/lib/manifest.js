const _ = require('lodash'),
      pluralize = require('pluralize'),
      { privatesAccessor } = require('./privates'),
      {
        rArray, rBool, isSet, isCustomName, removeFalsy
      } = require('./utils/values'),
      Fault = require('./fault'),
      FileAdapter = require('./stream/adapters/file_adapter')

// Augmented regular expresions. Accepts strings, star
class ARegex {

  constructor(input) {
    let value
    if (_.isString(input)) {
      const match = input.match(/^\/(.*)\/(.*)/)
      value = match ? new RegExp(match[1], match[2]) : input
    }
    if (_.isRegExp(input)) {
      value = input
    }

    Object.assign(privatesAccessor(this), { value })
  }

  test(pattern) {
    const value = privatesAccessor(this, 'value')
    if (_.isString(value)) {
      return value === '*' || _.isEqual(pattern, value)
    }
    if (_.isRegExp(value)) {
      return value.test(pattern)
    }

    return false
  }

  toJSON() {
    return privatesAccessor(this, 'value')
  }

}

// Basic matching stage
class ManifestStage {

  constructor(input, implicitStar = true) {
    const definition = input || {}

    if (!definition.includes && implicitStar) {
      definition.includes = ['*']
    }

    Object.assign(privatesAccessor(this), {
      dependencies: rBool(definition.dependencies, true),
      includes: rArray(definition.includes || [], true).map(v => new ARegex(v)),
      excludes: rArray(definition.excludes || [], true).map(v => new ARegex(v))
    })
  }

  get includes() {
    return privatesAccessor(this, 'includes')
  }

  get excludes() {
    return privatesAccessor(this, 'excludes')
  }

  get dependencies() {
    return privatesAccessor(this, 'dependencies')
  }

  shouldIncludeDependencies() {
    return this.dependencies
  }

  accept(path) {
    return this.includes.some(r => r.test(path))
      && !this.excludes.some(r => r.test(path))
  }

  toJSON() {
    return removeFalsy(privatesAccessor(this), true)
  }

}

class ObjectSection extends ManifestStage {

  constructor(def, key) {
    super(def)

    if (!def[key]) {
      throw Fault.create('kInvalidArgument', { reason: `The ${key} is missing from the manifest descriptor.` })
    }

    Object.assign(privatesAccessor(this), {
      key,
      keyTester: new ARegex(def[key])
    })
  }

  accept(path) {

    if (path) {

      const keyTester = privatesAccessor(this, 'keyTester'),
            [first, ...rest] = path.split('.')

      if (keyTester) {

        return keyTester.test(first)
          && (!rest.length || super.accept(rest.join('.')))
      }
      return false

    }

    return this.includes.length > 0 && !this.excludes.some(r => r.test(''))
  }

  toJSON() {
    const {
      includes, excludes, dependencies
    } = privatesAccessor(this)
    return removeFalsy({
      includes, excludes, dependencies, name: privatesAccessor(this, 'keyTester').toJSON()
    }, true)

  }

}

class Manifest extends ManifestStage {

  constructor(input) {
    const def = input || {},
          thisStages = {}

    super(def, !Object.keys(def).length)

    if (def.objects) {
      thisStages.objects = def.objects.map(section => new ObjectSection(section, 'name'))
    }

    // We defien a section for each built-in name
    Manifest.builtInSections.forEach((name) => {
      if (def[name]) {
        thisStages[name] = new ManifestStage(def[name])
      }
    })

    // We also define a section for each custom name to capture user data
    Object.keys(def).filter(isCustomName).forEach((name) => {
      if (def[name]) {
        thisStages[name] = new ManifestStage(def[name])
        Object.defineProperty(this, name, {
          get: () => privatesAccessor(this, name)
        })
      }
    })

    Object.assign(privatesAccessor(this), { thisStages })
  }

  static get builtInSections() {
    return [
      'env', 'configs', 'scripts', 'views', 'templates', 'apps', 'roles', 'serviceAccounts',
      'policies', 'notifications', 'storageLocations']
  }

  accept(path) {
    // Global include/exclude works on the last item of the path
    const { thisStages } = privatesAccessor(this),
          [last] = path.split('.').reverse(),
          [first, ...rest] = path.split('.')

    // dispatch acceptance to appropriate section
    if (thisStages[first]) {
      return _.isArray(thisStages[first])
        ? thisStages[first].some(section => section.accept(rest.join('.')))
        : thisStages[first].accept(rest.join('.'))
    }

    return this.includes.some(r => r.test(last))
      && !this.excludes.some(r => r.test(last))
  }

  shouldIncludeDependencies(path) {
    const { thisStages } = privatesAccessor(this),
          [head, ...tail] = path.split('.'),
          res = thisStages[head] && tail.length && thisStages[head].shouldIncludeDependencies(tail.join('.'))

    if (isSet(res)) {
      return res
    }
    return this.dependencies
  }

  [Symbol.iterator]() {

    const { thisStages } = privatesAccessor(this),
          keys = Object.keys(thisStages).sort().reverse()

    return {
      next: () => {
        if (keys.length === 0) {
          return { done: true }
        }
        const key = keys.pop()
        return { value: { name: key, stage: thisStages[key] }, done: false }
      }
    }

  }

  get env() {
    return privatesAccessor(this, 'env')
  }

  get configs() {
    return privatesAccessor(this, 'configs')
  }

  get objects() {
    return privatesAccessor(this, 'objects')
  }

  get scripts() {
    return privatesAccessor(this, 'scripts')
  }

  get views() {
    return privatesAccessor(this, 'views')
  }

  get templates() {
    return privatesAccessor(this, 'templates')
  }

  get apps() {
    return privatesAccessor(this, 'apps')
  }

  get roles() {
    return privatesAccessor(this, 'roles')
  }

  get serviceAccounts() {
    return privatesAccessor(this, 'serviceAccounts')
  }

  get policies() {
    return privatesAccessor(this, 'policies')
  }

  get notifications() {
    return privatesAccessor(this, 'notifications')
  }

  get storageLocations() {
    return privatesAccessor(this, 'storageLocations')
  }

  async addResource(type, name, template, params) {
    const resourcePath = `${pluralize(type)}.${name}`,
          stages = privatesAccessor(this, 'thisStages')
    if (!this.accept(resourcePath) || Object.keys(stages).length === 0) {
      stages[pluralize(type)] = stages[pluralize(type)] || type === 'object' ? [] : { includes: [] }
      if (type === 'object') {
        stages[pluralize(type)].push({
          includes: ['*'],
          name
        })
      } else {
        stages[pluralize(type)].includes.push(name)
      }
      await FileAdapter.addResource(params.dir || process.cwd(), params.format || 'json', type, template)
      await FileAdapter.saveManifest(params.dir || process.cwd(), params.format || 'json', stages)
    } else {
      throw Fault.create('kNotAccepted', { reason: 'Resource already exists or not accepted by manifest definition' })
    }
  }

}

module.exports = { Manifest, ARegex }
