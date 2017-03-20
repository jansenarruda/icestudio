'use strict';

angular.module('icestudio')
  .service('project', function($rootScope,
                               graph,
                               boards,
                               compiler,
                               profile,
                               utils,
                               common,
                               gettextCatalog,
                               nodeFs,
                               nodePath) {

    this.name = '';  // Used in File dialogs
    this.path = '';  // Used in Save / Save as
    this.filepath = ''; // Used to find external resources (*.v, *.list)
    this.changed = false;

    var project = _default();

    function _default() {
      return {
        version: common.VERSION,
        package: {
          name: '',
          version: '',
          description: '',
          author: '',
          image: ''
        },
        design: {
          board: '',
          graph: { blocks: [], wires: [] },
          state: { pan: { x: 0, y: 0 }, zoom: 1.0 }
        },
        dependencies: {}
      };
    }

    /* Dependency format
    {
      package: {
        name: '',
        version: '',
        description: '',
        author: '',
        image: ''
      },
      design: {
        graph: { blocks: [], wires: [] }
        state: { pan: { x: 0, y: 0 }, zoom: 1.0 }
      },
    }
    */

    this.get = function(key) {
      if (key in project) {
        return project[key];
      }
      else {
        return project;
      }
    };

    this.set = function(key, obj) {
      if (key in project) {
        project[key] = obj;
      }
    };

    this.new = function(name) {
      this.path = '';
      project = _default();
      this.updateTitle(name);

      graph.clearAll();
      graph.resetCommandStack();
      graph.setState(project.design.state);

      alertify.success(gettextCatalog.getString('New project {{name}} created', { name: utils.bold(name) }));
    };

    this.open = function(filepath, emptyPath) {
      var self = this;
      this.path = emptyPath ? '' : filepath;
      this.filepath = filepath;
      utils.readFile(filepath, function(data) {
        if (data) {
          var name = utils.basename(filepath);
          self.load(name, data);
        }
      });
    };

    this.load = function(name, data) {
      var self = this;
      if (data.version !== common.VERSION) {
        alertify.warning(gettextCatalog.getString('Old project format {{version}}', { version: data.version }), 5);
      }
      project = _safeLoad(data, name);
      if (project.design.board !== common.selectedBoard.name) {
        var projectBoard = boards.boardLabel(project.design.board);
        alertify.confirm(
          gettextCatalog.getString('This project is designed for the {{name}} board.', { name: utils.bold(projectBoard) }) + '<br>' +
          gettextCatalog.getString('Do you want to convert it?'),
        function() {
          project.design.board = common.selectedBoard.name;
          _load(true);
        },
        function() {
          _load();
        });
      }
      else {
        _load();
      }

      function _load(reset) {
        common.allDependencies = project.dependencies;
        var opt = { reset: reset || false, disabled: false };
        var ret = graph.loadDesign(project.design, opt, function() {
          graph.resetCommandStack();
          alertify.success(gettextCatalog.getString('Project {{name}} loaded', { name: utils.bold(name) }));
        });

        if (ret) {
          profile.set('board', boards.selectBoard(project.design.board));
          self.updateTitle(name);
        }
        else {
          alertify.error(gettextCatalog.getString('Wrong project format: {{name}}', { name: utils.bold(name) }), 30);
        }
      }
    };

    function _safeLoad(data, name) {
      // Backwards compatibility
      var project = {};
      switch(data.version) {
        case common.VERSION:
          project = data;
          break;
        case '1.0':
          project = convert10To11(data);
          break;
        default:
          project = convertTo10(data, name);
          project = convert10To11(project);
          break;
      }
      return project;
    }

    function convert10To11(data) {
      var project = _default();
      project.package = data.package;
      project.design.board = data.design.board;
      project.design.state = data.design.state;
      project.design.graph = data.design.graph;

      var depsInfo = findSubDependencies10(data.design.deps);
      replaceType10(project, depsInfo);
      for (var d in depsInfo) {
        var dep = depsInfo[d];
        replaceType10(dep.content, depsInfo);
        project.dependencies[dep.id] = dep.content;
      }

      return project;
    }

    function findSubDependencies10(deps) {
      var depsInfo = {};
      for (var key in deps) {
        var block = utils.clone(deps[key]);
        // Go recursive
        var subDepsInfo = findSubDependencies10(block.design.deps);
        for (var name in subDepsInfo) {
          if (!(name in depsInfo)) {
            depsInfo[name] = subDepsInfo[name];
          }
        }
        // Add current dependency
        block = pruneBlock(block);
        delete block.design.deps;
        block.package.name = block.package.name || key;
        block.package.description = block.package.description || key;
        if (!(key in depsInfo)) {
          depsInfo[key] = {
            id: utils.dependencyID(block),
            content: block
          };
        }
      }
      return depsInfo;
    }

    function replaceType10(project, depsInfo) {
      for (var i in project.design.graph.blocks) {
        var type = project.design.graph.blocks[i].type;
        if (type.indexOf('basic.') === -1) {
          project.design.graph.blocks[i].type = depsInfo[type].id;
        }
      }
    }

    function convertTo10(data, name) {
      var project = {
        version: '1.0',
        package: {
          name: name || '',
          version: '',
          description: name || '',
          author: '',
          image: ''
        },
        design: {
          board: '',
          graph: {},
          deps: {},
          state: {}
        },
      };
      for (var b in data.graph.blocks) {
        var block = data.graph.blocks[b];
        switch(block.type) {
          case 'basic.input':
          case 'basic.output':
            block.data = {
              name: block.data.label,
              pins: [{
                index: '0',
                name: block.data.pin ? block.data.pin.name : '',
                value: block.data.pin? block.data.pin.value : '0'
              }],
              virtual: false
            };
            break;
          case 'basic.constant':
            block.data = {
              name: block.data.label,
              value: block.data.value,
              local: false
            };
            break;
          case 'basic.code':
            var params = [];
            for (var p in block.data.params) {
              params.push({
                name: block.data.params[p]
              });
            }
            var inPorts = [];
            for (var i in block.data.ports.in) {
              inPorts.push({
                name: block.data.ports.in[i]
              });
            }

            var outPorts = [];
            for (var o in block.data.ports.out) {
              outPorts.push({
                name: block.data.ports.out[o]
              });
            }
            block.data = {
              code: block.data.code,
              params: params,
              ports: {
                in: inPorts,
                out: outPorts
              }
            };
            break;
        }
      }
      project.design.board = data.board;
      project.design.graph = data.graph;
      project.design.state = data.state;
      // Safe load all dependencies recursively
      for (var key in data.deps) {
        project.design.deps[key] = convertTo10(data.deps[key], key);
      }

      return project;
    }

    this.save = function(filepath) {
      var name = utils.basename(filepath);
      this.path = filepath;
      this.filepath = filepath;
      this.updateTitle(name);

      sortGraph();
      this.update();
      utils.saveFile(filepath, pruneProject(project), function() {
        // TODO: save external resources (*.v, *.list)
        alertify.success(gettextCatalog.getString('Project {{name}} saved', { name: utils.bold(name) }));
      }, true);
    };

    function sortGraph() {
      var cells = graph.getCells();

      // Sort cells by x-coordinate
      cells = _.sortBy(cells, function(cell) {
        if (!cell.isLink()) {
          return cell.attributes.position.x;
        }
      });

      // Sort cells by y-coordinate
      cells = _.sortBy(cells, function(cell) {
        if (!cell.isLink()) {
          return cell.attributes.position.y;
        }
      });

      graph.setCells(cells);
    }

    this.addAsBlock = function(filepath) {
      var self = this;
      utils.readFile(filepath, function(data) {
        if (data.version !== common.VERSION) {
          alertify.warning(gettextCatalog.getString('Old project format {{version}}', { version: data.version }), 5);
        }
        var name = utils.basename(filepath);
        var block = _safeLoad(data, name);
        if (block) {
          var path = utils.dirname(filepath);
          // 1. Parse and find included files
          var code = compiler.generate('verilog', block);
          var files = utils.findIncludedFiles(code);
          // Are there included files?
          if (files.length > 0) {
            // 2. Check project's directory
            if (self.path) {
              // 3. Copy the included files
              copyIncludedFiles(function(success) {
                if (success) {
                  // 4. Success: import block
                  doImportBlock(block);
                }
              });
            }
            else {
              alertify.confirm(gettextCatalog.getString('This import operation requires a project path. You need to save the current project. Do you want to continue?'),
                function() {
                  $rootScope.$emit('saveProjectAs', function() {
                    setTimeout(function() {
                      // 3. Copy the included files
                      copyIncludedFiles(function(success) {
                        if (success) {
                          // 4. Success: import block
                          doImportBlock(block);
                        }
                      });
                    }, 500);
                  });
              });
            }
          }
          else {
            // No included files to copy
            // 4. Import block
            doImportBlock(block);
          }
        }

        function copyIncludedFiles(callback) {
          var success = true;
          async.eachSeries(files, function(filename, next) {
            setTimeout(function() {
              var origPath = nodePath.join(path, filename);
              var destPath = nodePath.join(utils.dirname(self.path), filename);
              if (origPath !== destPath) {
                if (nodeFs.existsSync(destPath)) {
                  alertify.confirm(gettextCatalog.getString('File {{file}} already exists in the project path. Do you want to replace it?', { file: utils.bold(filename) }),
                  function() {
                    success = success && doCopySync(origPath, destPath, filename);
                    if (!success) {
                      return next(); // break
                    }
                    next();
                  },
                  function() {
                    next();
                  });
                }
                else {
                  success = success && doCopySync(origPath, destPath, filename);
                  if (!success) {
                    return next(); // break
                  }
                  next();
                }
              }
              else {
                return next(); // break
              }
            }, 0);
          }, function(/*result*/) {
            return callback(success);
          });
        }

        function doCopySync(orig, dest, filename) {
          var success = utils.copySync(orig, dest);
          if (success) {
            alertify.message(gettextCatalog.getString('File {{file}} imported', { file: utils.bold(filename) }), 5);
          }
          else {
            alertify.error(gettextCatalog.getString('Original file {{file}} does not exist', { file: utils.bold(filename) }), 30);
          }
          return success;
        }

        function doImportBlock(block) {
          self.addBlock(block);
          alertify.success(gettextCatalog.getString('Block {{name}} imported', { name: utils.bold(block.package.name) }));
        }
      });
    };

    function pruneProject (project) {
      var _project = utils.clone(project);

      _prune(_project);
      for (var d in _project.dependencies) {
        _prune(_project.dependencies[d]);
      }

      function _prune(_project) {
        for (var i in _project.design.graph.blocks) {
          var block = _project.design.graph.blocks[i];
          switch (block.type) {
            case 'basic.input':
            case 'basic.output':
            case 'basic.constant':
            case 'basic.info':
              break;
            case 'basic.code':
              for (var j in block.data.ports.in) {
                delete block.data.ports.in[j].default;
              }
              break;
            default:
              // Generic block
              delete block.data;
              break;
          }
        }
      }

      return _project;
    }

    this.update = function(opt, callback) {
      var graphData = graph.toJSON();
      var p = utils.cellsToProject(graphData.cells, opt);

      project.design.board = p.design.board;
      project.design.graph = p.design.graph;
      project.dependencies = p.dependencies;
      var state = graph.getState();
      project.design.state = {
        pan: {
          x: parseFloat(state.pan.x.toFixed(4)),
          y: parseFloat(state.pan.y.toFixed(4))
        },
        zoom: parseFloat(state.zoom.toFixed(4))
      };

      if (callback) {
        callback();
      }
    };

    this.updateTitle = function(name) {
      if (name) {
        this.name = name;
        graph.resetBreadcrumbs(name);
      }
      var title = (this.changed ? '*' : '') + this.name + ' ─ Icestudio';
      utils.updateWindowTitle(title);
    };

    this.export = function(target, filepath, message) {
      this.update();
      var opt = { boardRules: profile.get('boardRules') };
      var data = compiler.generate(target, project, opt);
      utils.saveFile(filepath, data, function() {
        alertify.success(message);
      }, false);
    };

    this.addBasicBlock = function(type) {
      graph.createBasicBlock(type);
    };

    this.addBlock = function(arg) {
      if (typeof arg === 'string') {
        // arg is a filepath
        utils.readFile(arg, function(block) {
          _addBlock(block);
        });
      }
      else {
        // arg is a block
        _addBlock(arg);
      }

      function _addBlock(block) {
        if (block) {
          block = _safeLoad(block);
          block = pruneBlock(block);
          var type = utils.dependencyID(block);
          utils.mergeDependencies(type, block);
          graph.createBlock(type, block);
        }
      }
    };

    function pruneBlock(block) {
      // Remove all unnecessary information for a dependency:
      // - version, board, FPGA I/O pins (->size if >1), virtual flag
      delete block.version;
      delete block.design.board;
      var i, pins;
      for (i in block.design.graph.blocks) {
        if (block.design.graph.blocks[i].type === 'basic.input' ||
            block.design.graph.blocks[i].type === 'basic.output') {
          if (block.design.graph.blocks[i].data.size === undefined) {
            pins = block.design.graph.blocks[i].data.pins;
            block.design.graph.blocks[i].data.size = (pins && pins.length > 1) ? pins.length : undefined;
          }
          delete block.design.graph.blocks[i].data.pins;
          delete block.design.graph.blocks[i].data.virtual;
        }
      }
      return block;
    }

    this.removeSelected = function() {
      graph.removeSelected();
    };

    this.clear = function() {
      project = _default();
      graph.clearAll();
      graph.resetBreadcrumbs();
      graph.resetCommandStack();
    };

  });
