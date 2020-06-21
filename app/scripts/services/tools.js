angular
  .module('icestudio')
  .service('tools', function (
    project,
    compiler,
    profile,
    collections,
    drivers,
    graph,
    utils,
    common,
    gettextCatalog,
    nodeGettext,
    nodeFs,
    nodeFse,
    nodePath,
    nodeChildProcess,
    nodeSSHexec,
    nodeRSync,
    nodeAdmZip,
    _package,
    $rootScope
  ) {
    'use strict';

    const _tcStr = function (str, args) {
      return gettextCatalog.getString(str, args);
    };

    var taskRunning = false;
    var resources = [];
    var startAlert = null;
    var infoAlert = null;
    var resultAlert = null;
    var toolchainAlert = null;
    var toolchain = {
      apio: '-',
      installed: false,
      disabled: false,
    };

    this.toolchain = toolchain;

    // Remove old build directory on start
    nodeFse.removeSync(common.OLD_BUILD_DIR);

    this.verifyCode = function (startMessage, endMessage) {
      return apioRun(
        ['verify', '--board', common.selectedBoard.name],
        startMessage,
        endMessage
      );
    };

    this.buildCode = function (startMessage, endMessage) {
      return apioRun(
        ['build', '--board', common.selectedBoard.name],
        startMessage,
        endMessage
      );
    };

    this.uploadCode = function (startMessage, endMessage) {
      return apioRun(
        ['upload', '--board', common.selectedBoard.name],
        startMessage,
        endMessage
      );
    };

    function apioRun(commands, startMessage, endMessage) {
      return new Promise(function (resolve) {
        var sourceCode = '';

        if (!taskRunning) {
          taskRunning = true;

          if (infoAlert) {
            infoAlert.dismiss(false);
          }

          if (resultAlert) {
            resultAlert.dismiss(false);
          }
          graph
            .resetCodeErrors()
            .then(function () {
              return new Promise(function (resolve, reject) {
                if (toolchain.installed) {
                  resolve();
                } else {
                  _toolchainNotInstalledAlert('Toolchain not installed');
                  reject();
                }
              });
            })
            .then(function () {
              utils.startWait();
              if (startMessage) {
                startAlert = alertify.message(startMessage, 100000);
              }

              return generateCode(commands);
            })
            .then(function (output) {
              sourceCode = output.code;

              return syncResources(output.code, output.internalResources);
            })
            .then(function () {
              var hostname = profile.get('remoteHostname');
              var command = commands[0];
              if (command === 'build' || command === 'upload') {
                commands = commands.concat('--verbose-pnr');
              }
              console.log('APIO', commands);
              if (hostname) {
                return executeRemote(commands, hostname);
              } else {
                return executeLocal(commands);
              }
            })
            .then(function (result) {
              return processResult(result, sourceCode);
            })
            .then(function () {
              // Success
              if (endMessage) {
                resultAlert = alertify.success(_tcStr(endMessage));
              }
              utils.endWait();
              restoreTask();
              resolve();
            })
            .catch(function (/* e */) {
              // Error
              utils.endWait();
              restoreTask();
            });
        }
      });
    }

    function restoreTask() {
      setTimeout(function () {
        // Wait 1s before run a task again
        if (startAlert) {
          startAlert.dismiss(false);
        }
        taskRunning = false;
      }, 1000);
    }

    function generateCode(cmd) {
      return new Promise(function (resolve) {
        project.snapshot();
        project.update();
        var opt = {
          datetime: false,
          boardRules: profile.get('boardRules'),
        };
        if (opt.boardRules) {
          opt.initPorts = compiler.getInitPorts(project.get());
          opt.initPins = compiler.getInitPins(project.get());
        }

        // Verilog file
        var verilogFile = compiler.generate('verilog', project.get(), opt)[0];
        nodeFs.writeFileSync(
          nodePath.join(common.BUILD_DIR, verilogFile.name),
          verilogFile.content,
          'utf8'
        );

        if (
          cmd.indexOf('verify') > -1 &&
          cmd.indexOf('--board') > -1 &&
          cmd.length === 3
        ) {
          //only verification
        } else {
          var archName = common.selectedBoard.info.arch;
          if (archName === 'ecp5') {
            // LPF file
            var lpfFile = compiler.generate('lpf', project.get(), opt)[0];
            nodeFs.writeFileSync(
              nodePath.join(common.BUILD_DIR, lpfFile.name),
              lpfFile.content,
              'utf8'
            );
          } else {
            // PCF file
            var pcfFile = compiler.generate('pcf', project.get(), opt)[0];
            nodeFs.writeFileSync(
              nodePath.join(common.BUILD_DIR, pcfFile.name),
              pcfFile.content,
              'utf8'
            );
          }
        }
        // List files
        var listFiles = compiler.generate('list', project.get());
        for (var i in listFiles) {
          var listFile = listFiles[i];

          nodeFs.writeFileSync(
            nodePath.join(common.BUILD_DIR, listFile.name),
            listFile.content,
            'utf8'
          );
        }

        project.restoreSnapshot();
        resolve({
          code: verilogFile.content,
          internalResources: listFiles.map(function (res) {
            return res.name;
          }),
        });
      });
    }

    function syncResources(code, internalResources) {
      return new Promise(function (resolve, reject) {
        // Remove resources
        removeFiles(resources);
        resources = [];
        // Find included files
        resources = resources.concat(findIncludedFiles(code));
        // Find list files
        resources = resources.concat(findInlineFiles(code));
        // Sync resources
        resources = _.uniq(resources);
        // Remove internal files
        resources = _.difference(resources, internalResources);
        syncFiles(resources, reject);
        resolve();
      });
    }

    function removeFiles(files) {
      _.each(files, function (file) {
        var filepath = nodePath.join(common.BUILD_DIR, file);
        nodeFse.removeSync(filepath);
      });
    }

    function findIncludedFiles(code) {
      return findFiles(
        /[\n|\s]\/\/\s*@include\s+([^\s]*\.(v|vh|list))(\n|\s)/g,
        code
      );
    }

    function findInlineFiles(code) {
      return findFiles(/[\n|\s][^\/]?\"(.*\.list?)\"/g, code);
    }

    // TODO: duplicated: utils findIncludedFiles
    function findFiles(pattern, code) {
      var match;
      var files = [];
      while ((match = pattern.exec(code))) {
        files.push(match[1]);
      }
      return files;
    }

    function syncFiles(files, reject) {
      _.each(files, function (file) {
        var destPath = nodePath.join(common.BUILD_DIR, file);
        var origPath = nodePath.join(utils.dirname(project.filepath), file);

        // Copy file
        var copySuccess = utils.copySync(origPath, destPath);
        if (!copySuccess) {
          resultAlert = alertify.error(
            _tcStr('File {{file}} does not exist', {
              file: file,
            }),
            30
          );
          reject();
        }
      });
    }

    this.checkToolchain = checkToolchain;

    function checkToolchain(callback) {
      var apio = utils.getApioExecutable();
      nodeChildProcess.exec([apio, '--version'].join(' '), function (
        error,
        stdout /*, stderr*/
      ) {
        if (error) {
          toolchain.apio = '';
          toolchain.installed = false;
          // Apio not installed
          _toolchainNotInstalledAlert('Toolchain not installed');
          if (callback) {
            callback();
          }
        } else {
          toolchain.apio = stdout.match(/apio,\sversion\s(.+)/i)[1];
          toolchain.installed =
            toolchain.apio >= _package.apio.min &&
            toolchain.apio < _package.apio.max;
          if (toolchain.installed) {
            nodeChildProcess.exec(
              [apio, 'clean', '-p', common.SAMPLE_DIR].join(' '),
              function (error /*, stdout, stderr*/) {
                toolchain.installed = !error;
                if (error) {
                  toolchain.apio = '';
                  // Toolchain not properly installed
                  _toolchainNotInstalledAlert('Toolchain not installed');
                }
                if (callback) {
                  callback();
                }
              }
            );
          } else {
            // An old version is installed
            _toolchainNotInstalledAlert('Toolchain version does not match');
            if (callback) {
              callback();
            }
          }
        }
      });
    }

    function _toolchainNotInstalledAlert(message) {
      if (resultAlert) {
        resultAlert.dismiss(false);
      }
      resultAlert = alertify.warning(
        `${_tcStr(message)}.<br>` + _tcStr('Click here to install it'),
        100000,
        function (isClicked) {
          if (isClicked) {
            $rootScope.$broadcast('installToolchain');
          }
        }
      );
    }

    function executeRemote(commands, hostname) {
      return new Promise(function (resolve) {
        startAlert.setContent(_tcStr('Synchronize remote files ...'));
        nodeRSync(
          {
            src: common.BUILD_DIR + '/',
            dest: hostname + ':.build/',
            ssh: true,
            recursive: true,
            delete: true,
            include: ['*.v', '*.pcf', '*.lpf', '*.list'],
            exclude: [
              '.sconsign.dblite',
              '*.out',
              '*.blif',
              '*.asc',
              '*.bin',
              '*.config',
              '*.json',
            ],
          },
          function (error, stdout, stderr /*, cmd*/) {
            if (!error) {
              startAlert.setContent(
                _tcStr('Execute remote {{label}} ...', {
                  label: '',
                })
              );
              nodeSSHexec(
                ['apio']
                  .concat(commands)
                  .concat(['--project-dir', '.build'])
                  .join(' '),
                hostname,
                function (error, stdout, stderr) {
                  resolve({
                    error: error,
                    stdout: stdout,
                    stderr: stderr,
                  });
                }
              );
            } else {
              resolve({
                error: error,
                stdout: stdout,
                stderr: stderr,
              });
            }
          }
        );
      });
    }

    function executeLocal(commands) {
      return new Promise(function (resolve) {
        if (commands[0] === 'upload') {
          // Upload command requires drivers setup (Mac OS)
          drivers.preUpload(function () {
            _executeLocal();
          });
        } else {
          // Other !upload commands
          _executeLocal();
        }

        function _executeLocal() {
          var apio = utils.getApioExecutable();
          var command = [apio]
            .concat(commands)
            .concat(['-p', utils.coverPath(common.BUILD_DIR)])
            .join(' ');
          console.log('APIO COMMAND', command);
          if (
            typeof common.DEBUGMODE !== 'undefined' &&
            common.DEBUGMODE === 1
          ) {
            const fs = require('fs');
            fs.appendFileSync(
              common.LOGFILE,
              'tools._executeLocal>' + command + '\n'
            );
          }
          nodeChildProcess.exec(
            command,
            {
              maxBuffer: 5000 * 1024,
            }, // To avoid buffer overflow
            function (error, stdout, stderr) {
              if (commands[0] === 'upload') {
                // Upload command requires to restore the drivers (Mac OS)
                drivers.postUpload();
              }
              common.commandOutput = command + '\n\n' + stdout + stderr;
              $(document).trigger('commandOutputChanged', [
                common.commandOutput,
              ]);
              resolve({
                error: error,
                stdout: stdout,
                stderr: stderr,
              });
            }
          );
        }
      });
    }

    function processResult(result, code) {
      result = result || {};
      var _error = result.error;
      var stdout = result.stdout;
      var stderr = result.stderr;

      return new Promise(function (resolve, reject) {
        if (_error || stderr) {
          // -- Process errors
          reject();
          if (stdout) {
            var boardName = common.selectedBoard.name;
            var boardLabel = common.selectedBoard.info.label;
            // - Apio errors
            if (
              stdout.indexOf('Error: board ' + boardName + ' not connected') !==
                -1 ||
              stdout.indexOf('USBError') !== -1 ||
              stdout.indexOf('Activate bootloader') !== -1
            ) {
              var errorMessage = _tcStr('Board {{name}} not connected', {
                name: utils.bold(boardLabel),
              });
              if (stdout.indexOf('Activate bootloader') !== -1) {
                if (common.selectedBoard.name.startsWith('TinyFPGA-B')) {
                  // TinyFPGA bootloader notification
                  errorMessage +=
                    '</br>(' + _tcStr('Bootloader not active') + ')';
                }
              }
              resultAlert = alertify.error(errorMessage, 30);
            } else if (
              stdout.indexOf('Error: board ' + boardName + ' not available') !==
              -1
            ) {
              resultAlert = alertify.error(
                _tcStr('Board {{name}} not available', {
                  name: utils.bold(boardLabel),
                }),
                30
              );
              setupDriversAlert();
            } else if (stdout.indexOf('Error: unknown board') !== -1) {
              resultAlert = alertify.error(_tcStr('Unknown board'), 30);
            } else if (stdout.indexOf('[upload] Error') !== -1) {
              switch (common.selectedBoard.name) {
                // TinyFPGA-B2 programmer errors
                case 'TinyFPGA-B2':
                case 'TinyFPGA-BX':
                  var match = stdout.match(/Bootloader\snot\sactive/g);
                  if (match && match.length === 3) {
                    resultAlert = alertify.error(
                      _tcStr('Bootloader not active'),
                      30
                    );
                  } else if (stdout.indexOf('Device or resource busy') !== -1) {
                    resultAlert = alertify.error(
                      _tcStr('Board {{name}} not available', {
                        name: utils.bold(boardLabel),
                      }),
                      30
                    );
                    setupDriversAlert();
                  } else if (
                    stdout.indexOf(
                      'device disconnected or multiple access on port'
                    ) !== -1
                  ) {
                    resultAlert = alertify.error(
                      _tcStr('Board {{name}} disconnected', {
                        name: utils.bold(boardLabel),
                      }),
                      30
                    );
                  } else {
                    resultAlert = alertify.error(_tcStr(stdout), 30);
                  }
                  break;
                default:
                  resultAlert = alertify.error(_tcStr(stdout), 30);
              }
              console.warn(stdout);
            }
            // Yosys error (Mac OS)
            else if (
              stdout.indexOf('Library not loaded:') !== -1 &&
              stdout.indexOf('libffi') !== -1
            ) {
              resultAlert = alertify.error(
                _tcStr('Configuration not completed'),
                30
              );
              setupDriversAlert();
            }
            // - Arachne-pnr errors
            else if (
              stdout.indexOf('set_io: too few arguments') !== -1 ||
              stdout.indexOf('fatal error: unknown pin') !== -1
            ) {
              resultAlert = alertify.error(
                _tcStr('FPGA I/O ports not defined'),
                30
              );
            } else if (
              stdout.indexOf('fatal error: duplicate pin constraints') !== -1
            ) {
              resultAlert = alertify.error(
                _tcStr('Duplicated FPGA I/O ports'),
                30
              );
            } else {
              var re,
                matchError,
                codeErrors = [];

              // - Iverilog errors & warnings
              // main.v:#: error: ...
              // main.v:#: warning: ...
              // main.v:#: syntax error
              re = /main.v:([0-9]+):\s(error|warning):\s(.*?)[\r|\n]/g;
              while ((matchError = re.exec(stdout))) {
                codeErrors.push({
                  line: parseInt(matchError[1]),
                  msg: matchError[3].replace(/\sin\smain\..*$/, ''),
                  type: matchError[2],
                });
              }
              re = /main.v:([0-9]+):\ssyntax\serror[\r|\n]/g;
              while ((matchError = re.exec(stdout))) {
                codeErrors.push({
                  line: parseInt(matchError[1]),
                  msg: 'Syntax error',
                  type: 'error',
                });
              }
              // - Yosys errors
              // ERROR: ... main.v:#...
              // Warning: ... main.v:#...
              re = /(ERROR|Warning):\s(.*?)\smain\.v:([0-9]+)(.*?)[\r|\n]/g;
              var msg = '';
              var line = -1;
              var type = false;
              var preContent = false;
              var postContent = false;

              while ((matchError = re.exec(stdout))) {
                msg = '';
                line = parseInt(matchError[3]);
                type = matchError[1].toLowerCase();
                preContent = matchError[2];
                postContent = matchError[4];
                // Process error
                if (preContent === 'Parser error in line') {
                  postContent = postContent.substring(2); // remove :\s
                  if (postContent.startsWith('syntax error')) {
                    postContent = 'Syntax error';
                  }
                  msg = postContent;
                } else if (preContent.endsWith(' in line ')) {
                  msg = preContent.replace(/\sin\sline\s$/, ' ') + postContent;
                } else {
                  preContent = preContent.replace(/\sat\s$/, '');
                  preContent = preContent.replace(/\sin\s$/, '');
                  msg = preContent;
                }
                codeErrors.push({
                  line: line,
                  msg: msg,
                  type: type,
                });
              }

              // - Yosys syntax errors
              // - main.v:31: ERROR: #...
              re = /\smain\.v:([0-9]+):\s(.*?)(ERROR):\s(.*?)[\r|\n]/g;
              while ((matchError = re.exec(stdout))) {
                msg = '';
                line = parseInt(matchError[1]);
                type = matchError[3].toLowerCase();
                preContent = matchError[4];

                // If the error is about an unexpected token, the error is not
                // deterministic, therefore we indicate that "the error
                //is around this line ..."
                if (preContent.indexOf('unexpected TOK_') >= 0) {
                  msg = 'Syntax error arround this line';
                } else {
                  msg = preContent;
                }
                codeErrors.push({
                  line: line,
                  msg: msg,
                  type: type,
                });
              }

              // Extract modules map from code
              var modules = mapCodeModules(code);
              var hasErrors = false;
              var hasWarnings = false;
              for (var i in codeErrors) {
                var codeError = normalizeCodeError(codeErrors[i], modules);
                if (codeError) {
                  // Launch codeError event
                  $(document).trigger('codeError', [codeError]);
                  hasErrors = hasErrors || codeError.type === 'error';
                  hasWarnings = hasWarnings || codeError.type === 'warning';
                }
              }

              if (hasErrors) {
                resultAlert = alertify.error(
                  _tcStr('Errors detected in the design'),
                  5
                );
              } else {
                if (hasWarnings) {
                  resultAlert = alertify.warning(
                    _tcStr('Warnings detected in the design'),
                    5
                  );
                }

                // var stdoutWarning = stdout.split('\n').filter(function (line) {
                //   line = line.toLowerCase();
                //   return (line.indexOf('warning: ') !== -1);
                // });
                var stdoutError = stdout.split('\n').filter(function (line) {
                  line = line.toLowerCase();
                  return (
                    line.indexOf('error: ') !== -1 ||
                    line.indexOf('not installed') !== -1 ||
                    line.indexOf('already declared') !== -1
                  );
                });
                // stdoutWarning.forEach(function (warning) {
                //   alertify.warning(warning, 20);
                // });
                if (stdoutError.length > 0) {
                  // Show first error
                  var error = 'There are errors in the Design...';
                  // hardware.blif:#: fatal error: ...
                  re = /hardware\.blif:([0-9]+):\sfatal\serror:\s(.*)/g;

                  // ERROR: Cell xxx cannot be bound to ..... since it is already bound
                  var re2 = /ERROR:\s(.*)\scannot\sbe\sbound\sto\s(.*)since\sit\sis\salready\sbound/g;

                  // ERROR: package does not have a pin named 'NULL' (on line 3)
                  var re3 = /ERROR:\spackage\sdoes\snot\shave\sa\spin\snamed\s'NULL/g;

                  if ((matchError = re.exec(stdoutError[0]))) {
                    error = matchError[2];
                  } else if ((matchError = re2.exec(stdoutError[0]))) {
                    error = 'Duplicated pins';
                  } else if ((matchError = re3.exec(stdoutError[0]))) {
                    error = 'Pin not assigned (NULL)';
                  } else {
                    error += '\n' + stdoutError[0];
                  }
                  resultAlert = alertify.error(error, 30);
                } else {
                  resultAlert = alertify.error(stdout, 30);
                }
              }
            }
          } else if (stderr) {
            // Remote hostname errors
            if (
              stderr.indexOf('Could not resolve hostname') !== -1 ||
              stderr.indexOf('Connection refused') !== -1
            ) {
              resultAlert = alertify.error(
                _tcStr('Wrong remote hostname {{name}}', {
                  name: profile.get('remoteHostname'),
                }),
                30
              );
            } else if (stderr.indexOf('No route to host') !== -1) {
              resultAlert = alertify.error(
                _tcStr('Remote host {{name}} not connected', {
                  name: profile.get('remoteHostname'),
                }),
                30
              );
            } else {
              resultAlert = alertify.error(stderr, 30);
            }
          }
        } else {
          //-- Process output
          resolve();

          if (stdout) {
            // Show used resources in the FPGA
            if (typeof common.FPGAResources.nextpnr === 'undefined') {
              common.FPGAResources.nextpnr = {
                LC: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                RAM: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                IO: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                GB: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                PLL: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                WB: {
                  used: '-',
                  total: '-',
                  percentage: '-',
                },
                MF: {
                  value: 0,
                },
              };
            }
            common.FPGAResources.nextpnr.LC = findValueNPNR(
              /_LC:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.LC
            );
            common.FPGAResources.nextpnr.RAM = findValueNPNR(
              /_RAM:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.RAM
            );
            common.FPGAResources.nextpnr.IO = findValueNPNR(
              /SB_IO:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.IO
            );
            common.FPGAResources.nextpnr.GB = findValueNPNR(
              /SB_GB:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.GB
            );
            common.FPGAResources.nextpnr.PLL = findValueNPNR(
              /_PLL:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.PLL
            );
            common.FPGAResources.nextpnr.WB = findValueNPNR(
              /_WARMBOOT:\s{1,}(\d+)\/\s{1,}(\d+)\s{1,}(\d+)%/g,
              stdout,
              common.FPGAResources.nextpnr.WB
            );
            common.FPGAResources.nextpnr.MF = findMaxFreq(
              /Max frequency for clock '[\w\W]+': ([\d\.]+) MHz/g,
              stdout,
              common.FPGAResources.nextpnr.MF
            );
            utils.rootScopeSafeApply();
          }
        }
      });
    }

    function findValueNPNR(pattern, output, previousValue) {
      var match = pattern.exec(output);
      if (match && match[1] && match[2] && match[3]) {
        return {
          used: match[1],
          total: match[2],
          percentage: match[3],
        };
      }
      return previousValue;
    }

    function findMaxFreq(pattern, output, previousValue) {
      var match = pattern.exec(output);
      if (match && match[1]) {
        return {
          value: match[1],
        };
      }
      return previousValue;
    }

    /*    function findValue(pattern, output, previousValue) {
          var match = pattern.exec(output);
          return (match && match[1]) ? match[1] : previousValue;
        }
    */
    function mapCodeModules(code) {
      var codelines = code.split('\n');
      var match,
        module = {
          params: [],
        },
        modules = [];
      // Find begin/end lines of the modules
      for (var i in codelines) {
        var codeline = codelines[i];
        // Get the module name
        if (!module.name) {
          match = /^module\s(.*?)[\s|;]/.exec(codeline);
          if (match) {
            module.name = match[1];
            continue;
          }
        }
        // Get the module parameters
        if (!module.begin) {
          match = /^\sparameter\s(.*?)\s/.exec(codeline);
          if (match) {
            module.params.push({
              name: match[1],
              line: parseInt(i) + 1,
            });
            continue;
          }
        }
        // Get the begin of the module code
        if (!module.begin) {
          match = /;$/.exec(codeline);
          if (match) {
            module.begin = parseInt(i) + 1;
            continue;
          }
        }
        // Get the end of the module code
        if (!module.end) {
          match = /^endmodule$/.exec(codeline);
          if (match) {
            module.end = parseInt(i) + 1;
            modules.push(module);
            module = {
              params: [],
            };
          }
        }
      }
      return modules;
    }

    function normalizeCodeError(codeError, modules) {
      var newCodeError;
      // Find the module with the error
      for (var i in modules) {
        var module = modules[i];
        if (codeError.line <= module.end) {
          newCodeError = {
            type: codeError.type,
            msg: codeError.msg,
          };
          // Find constant blocks in Yosys error:
          //  The error comes from the generated code
          //  but the origin is the constant block value
          var re = /Failed\sto\sdetect\swidth\sfor\sparameter\s\\(.*?)\sat/g;
          var matchConstant = re.exec(newCodeError.msg);

          if (codeError.line > module.begin && !matchConstant) {
            if (module.name.startsWith('main_')) {
              // Code block
              newCodeError.blockId = module.name.split('_')[1];
              newCodeError.blockType = 'code';
              newCodeError.line =
                codeError.line -
                module.begin -
                (codeError.line === module.end ? 1 : 0);
            } else {
              // Generic block

              newCodeError.blockId = module.name.split('_')[0];
              newCodeError.blockType = 'generic';
            }
            break;
          } else {
            if (module.name === 'main') {
              // Constant block
              for (var j in module.params) {
                var param = module.params[j];
                if (
                  codeError.line === param.line ||
                  (matchConstant && param.name === matchConstant[1])
                ) {
                  newCodeError.blockId = param.name;
                  newCodeError.blockType = 'constant';
                  break;
                }
              }
            } else {
              // Generic block
              newCodeError.blockId = module.name;
              newCodeError.blockType = 'generic';
            }
            break;
          }
        }
      }
      return newCodeError;
    }

    // Toolchain methods

    $rootScope.$on(
      'installToolchain',
      function (/*event*/) {
        this.installToolchain();
      }.bind(this)
    );

    this.installToolchain = function () {
      if (resultAlert) {
        resultAlert.dismiss(false);
      }
      if (utils.checkDefaultToolchain()) {
        utils.removeToolchain();
        installDefaultToolchain();
      } else {
        alertify.confirm(
          _tcStr(
            'Default toolchain not found. Toolchain will be downloaded. This operation requires Internet connection. Do you want to continue?'
          ),
          function () {
            utils.removeToolchain();
            installOnlineToolchain();
          }
        );
      }
    };

    this.updateToolchain = function () {
      if (resultAlert) {
        resultAlert.dismiss(false);
      }
      alertify.confirm(
        _tcStr(
          'The toolchain will be updated. This operation requires Internet connection. Do you want to continue?'
        ),
        function () {
          installOnlineToolchain();
        }
      );
    };

    this.resetToolchain = function () {
      if (resultAlert) {
        resultAlert.dismiss(false);
      }
      if (utils.checkDefaultToolchain()) {
        alertify.confirm(
          _tcStr(
            'The toolchain will be restored to default. Do you want to continue?'
          ),
          function () {
            utils.removeToolchain();
            installDefaultToolchain();
          }
        );
      } else {
        alertify.alert(
          _tcStr("Error: default toolchain not found in '{{dir}}'", {
            dir: common.TOOLCHAIN_DIR,
          })
        );
      }
    };

    this.removeToolchain = function () {
      if (resultAlert) {
        resultAlert.dismiss(false);
      }
      alertify.confirm(
        _tcStr('The toolchain will be removed. Do you want to continue?'),
        function () {
          utils.removeToolchain();
          toolchain.apio = '';
          toolchain.installed = false;
          alertify.success(_tcStr('Toolchain removed'));
        }
      );
    };

    $rootScope.$on(
      'enableDrivers',
      function (/*event*/) {
        this.enableDrivers();
      }.bind(this)
    );

    this.enableDrivers = function () {
      checkToolchain(function () {
        if (toolchain.installed) {
          drivers.enable();
        }
      });
    };

    this.disableDrivers = function () {
      checkToolchain(function () {
        if (toolchain.installed) {
          drivers.disable();
        }
      });
    };

    function installDefaultToolchain() {
      installationStatus();

      var content = [
        '<div>',
        '  <p id="progress-message">' + _tcStr('Installing toolchain') + '</p>',
        '  </br>',
        '  <div class="progress">',
        '    <div id="progress-bar" class="progress-bar progress-bar-info progress-bar-striped active" role="progressbar"',
        '    aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" style="width:0%">',
        '    </div>',
        '  </div>',
        '</div>',
      ].join('\n');
      toolchainAlert = alertify.alert(content, function () {
        setTimeout(function () {
          initProgress();
          // Restore OK button
          $(toolchainAlert.__internal.buttons[0].element).removeClass('hidden');
        }, 200);
      });
      // Hide OK button
      $(toolchainAlert.__internal.buttons[0].element).addClass('hidden');

      toolchain.installed = false;

      // Reset toolchain
      async.series([
        ensurePythonIsAvailable,
        extractVirtualenv,
        createVirtualenv,
        extractDefaultApio,
        installDefaultApio,
        extractDefaultApioPackages,
        installationCompleted,
      ]);
    }

    function installOnlineToolchain() {
      installationStatus();

      var content = [
        '<div>',
        '  <p id="progress-message">' + _tcStr('Installing toolchain') + '</p>',
        '  </br>',
        '  <div class="progress">',
        '    <div id="progress-bar" class="progress-bar progress-bar-info progress-bar-striped active" role="progressbar"',
        '    aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" style="width:0%">',
        '    </div>',
        '  </div>',
        '</div>',
      ].join('\n');
      toolchainAlert = alertify.alert(content, function () {
        setTimeout(function () {
          initProgress();
          // Restore OK button
          $(toolchainAlert.__internal.buttons[0].element).removeClass('hidden');
        }, 200);
      });
      // Hide OK button
      $(toolchainAlert.__internal.buttons[0].element).addClass('hidden');

      toolchain.installed = false;

      // Install toolchain
      async.series([
        checkInternetConnection,
        ensurePythonIsAvailable,
        extractVirtualenv,
        createVirtualenv,
        installOnlineApio,
        apioInstallSystem,
        apioInstallYosys,
        apioInstallIce40,
        apioInstallECP5,
        apioInstallFujprog,
        apioInstallIverilog,
        apioInstallDrivers,
        apioInstallScons,
        apioInstallIcesprog,
        installationCompleted,
      ]);
    }

    function checkInternetConnection(callback) {
      updateProgress(_tcStr('Check Internet connection...'), 0);
      utils.isOnline(callback, function () {
        closeToolchainAlert();
        restoreStatus();
        resultAlert = alertify.error(
          _tcStr('Internet connection required'),
          30
        );
        callback(true);
      });
    }

    function ensurePythonIsAvailable(callback) {
      updateProgress(_tcStr('Check Python...'), 0);
      if (utils.getPythonExecutable()) {
        callback();
      } else {
        closeToolchainAlert();
        restoreStatus();
        resultAlert = alertify.error(
          _tcStr('At least Python 3.5 is required'),
          30
        );
        callback(true);
      }
    }

    function extractVirtualenv(callback) {
      updateProgress(_tcStr('Extract virtualenv files...'), 5);
      utils.extractVirtualenv(callback);
    }

    function createVirtualenv(callback) {
      updateProgress(_tcStr('Create virtualenv...'), 10);
      utils.createVirtualenv(callback);
    }

    // Local installation

    function extractDefaultApio(callback) {
      updateProgress(_tcStr('Extract default apio files...'), 30);
      utils.extractDefaultApio(callback);
    }

    function installDefaultApio(callback) {
      updateProgress(_tcStr('Install default apio...'), 50);
      utils.installDefaultApio(callback);
    }

    function extractDefaultApioPackages(callback) {
      updateProgress(_tcStr('Extract default apio packages...'), 70);
      utils.extractDefaultApioPackages(callback);
    }

    // Remote installation

    function installOnlineApio(callback) {
      var extraPackages = _package.apio.extras || [];
      var apio = utils.getApioInstallable();

      updateProgress(
        'pip install -U ' + apio + '[' + extraPackages.toString() + ']',
        30
      );
      utils.installOnlineApio(callback);
    }

    function apioInstallSystem(callback) {
      updateProgress('apio install system', 40);
      utils.apioInstall('system', callback);
    }

    function apioInstallYosys(callback) {
      updateProgress('apio install yosys', 50);
      utils.apioInstall('yosys', callback);
    }

    function apioInstallIce40(callback) {
      updateProgress('apio install ice40', 50);
      utils.apioInstall('ice40', callback);
    }

    function apioInstallECP5(callback) {
      updateProgress('apio install ecp5', 50);
      utils.apioInstall('ecp5', callback);
    }

    function apioInstallFujprog(callback) {
      updateProgress('apio install fujprog', 50);
      utils.apioInstall('fujprog', callback);
    }

    function apioInstallIverilog(callback) {
      updateProgress('apio install iverilog', 70);
      utils.apioInstall('iverilog', callback);
    }

    function apioInstallIcesprog(callback) {
      updateProgress('apio install icesprog', 50);
      utils.apioInstall('icesprog', callback);
    }

    function apioInstallDrivers(callback) {
      if (common.WIN32) {
        updateProgress('apio install drivers', 80);
        utils.apioInstall('drivers', callback);
      } else {
        callback();
      }
    }

    function apioInstallScons(callback) {
      updateProgress('apio install scons', 90);
      utils.apioInstall('scons', callback);
    }

    function installationCompleted(callback) {
      checkToolchain(function () {
        if (toolchain.installed) {
          closeToolchainAlert();
          updateProgress(_tcStr('Installation completed'), 100);
          alertify.success(_tcStr('Toolchain installed'));
          setupDriversAlert();
        }
        restoreStatus();
        callback();
      });
    }

    function setupDriversAlert() {
      if (common.showDrivers()) {
        var message = _tcStr('Click here to <b>setup the drivers</b>');
        if (!infoAlert) {
          setTimeout(function () {
            infoAlert = alertify.message(message, 30);
            infoAlert.callback = function (isClicked) {
              infoAlert = null;
              if (isClicked) {
                if (resultAlert) {
                  resultAlert.dismiss(false);
                }
                $rootScope.$broadcast('enableDrivers');
              }
            };
          }, 1000);
        }
      }
    }

    function updateProgress(message, value) {
      $('#progress-message').text(message);
      var bar = $('#progress-bar');
      if (value === 100) {
        bar.removeClass('progress-bar-striped active');
      }
      bar.text(value + '%');
      bar.attr('aria-valuenow', value);
      bar.css('width', value + '%');
    }

    function initProgress() {
      $('#progress-bar')
        .addClass('notransition progress-bar-info progress-bar-striped active')
        .removeClass('progress-bar-danger')
        .text('0%')
        .attr('aria-valuenow', 0)
        .css('width', '0%')
        .removeClass('notransition');
    }

    function closeToolchainAlert() {
      toolchainAlert.callback();
      toolchainAlert.close();
    }

    function installationStatus() {
      // Disable user events
      utils.disableKeyEvents();
      utils.disableClickEvents();
      utils.startWait();
    }

    function restoreStatus() {
      // Enable user events
      utils.enableKeyEvents();
      utils.enableClickEvents();
      utils.endWait();
    }

    // Collections management

    this.addCollections = function (filepaths) {
      // Load zip file
      async.eachSeries(filepaths, function (filepath, nextzip) {
        //alertify.message(_tcStr('Load {{name}} ...', { name: utils.bold(utils.basename(filepath)) }));
        var zipData = nodeAdmZip(filepath);
        var _collections = getCollections(zipData);

        async.eachSeries(
          _collections,
          function (collection, next) {
            setTimeout(function () {
              if (
                collection.package &&
                (collection.blocks || collection.examples)
              ) {
                alertify.prompt(
                  _tcStr('Add collection'),
                  _tcStr('Enter name for the collection:'),
                  collection.origName,
                  function (evt, name) {
                    if (!name) {
                      return false;
                    }
                    collection.name = name;

                    var destPath = nodePath.join(
                      common.INTERNAL_COLLECTIONS_DIR,
                      name
                    );
                    if (nodeFs.existsSync(destPath)) {
                      alertify.confirm(
                        _tcStr('The collection {{name}} already exists.', {
                          name: utils.bold(name),
                        }) +
                          '<br>' +
                          _tcStr('Do you want to replace it?'),
                        function () {
                          utils.deleteFolderRecursive(destPath);
                          installCollection(collection, zipData);
                          alertify.success(
                            _tcStr('Collection {{name}} replaced', {
                              name: utils.bold(name),
                            })
                          );
                          next(name);
                        },
                        function () {
                          alertify.warning(
                            _tcStr('Collection {{name}} not replaced', {
                              name: utils.bold(name),
                            })
                          );
                          next(name);
                        }
                      );
                    } else {
                      installCollection(collection, zipData);
                      alertify.success(
                        _tcStr('Collection {{name}} added', {
                          name: utils.bold(name),
                        })
                      );
                      next(name);
                    }
                  },
                  function () {}
                );
              } else {
                alertify.warning(
                  _tcStr('Invalid collection {{name}}', {
                    name: utils.bold(name),
                  })
                );
              }
            }, 0);
          },
          function () {
            collections.loadInternalCollections();
            utils.rootScopeSafeApply();
            nextzip();
          }
        );
      });
    };

    function getCollections(zipData) {
      var data = '';
      var _collections = {};
      var zipEntries = zipData.getEntries();

      // Validate collections
      zipEntries.forEach(function (zipEntry) {
        data = zipEntry.entryName.match(/^([^\/]+)\/$/);
        if (data) {
          _collections[data[1]] = {
            origName: data[1],
            blocks: [],
            examples: [],
            locale: [],
            package: '',
          };
        }

        addCollectionItem('blocks', 'ice', _collections, zipEntry);
        addCollectionItem('blocks', 'v', _collections, zipEntry);
        addCollectionItem('blocks', 'vh', _collections, zipEntry);
        addCollectionItem('blocks', 'list', _collections, zipEntry);
        addCollectionItem('examples', 'ice', _collections, zipEntry);
        addCollectionItem('examples', 'v', _collections, zipEntry);
        addCollectionItem('examples', 'vh', _collections, zipEntry);
        addCollectionItem('examples', 'list', _collections, zipEntry);
        addCollectionItem('locale', 'po', _collections, zipEntry);

        data = zipEntry.entryName.match(/^([^\/]+)\/package\.json$/);
        if (data) {
          _collections[data[1]].package = zipEntry.entryName;
        }
        data = zipEntry.entryName.match(/^([^\/]+)\/README\.md$/);
        if (data) {
          _collections[data[1]].readme = zipEntry.entryName;
        }
      });

      return _collections;
    }

    function addCollectionItem(key, ext, collections, zipEntry) {
      var data = zipEntry.entryName.match(
        RegExp('^([^/]+)/' + key + '/.*.' + ext + '$')
      );
      if (data) {
        collections[data[1]][key].push(zipEntry.entryName);
      }
    }

    function installCollection(collection, zip) {
      var i,
        dest = '';
      var pattern = RegExp('^' + collection.origName);
      for (i in collection.blocks) {
        dest = collection.blocks[i].replace(pattern, collection.name);
        safeExtract(collection.blocks[i], dest, zip);
      }
      for (i in collection.examples) {
        dest = collection.examples[i].replace(pattern, collection.name);
        safeExtract(collection.examples[i], dest, zip);
      }
      for (i in collection.locale) {
        dest = collection.locale[i].replace(pattern, collection.name);
        safeExtract(collection.locale[i], dest, zip);
        // Generate locale JSON files
        var compiler = new nodeGettext.Compiler({
          format: 'json',
        });
        var sourcePath = nodePath.join(common.INTERNAL_COLLECTIONS_DIR, dest);
        var targetPath = nodePath.join(
          common.INTERNAL_COLLECTIONS_DIR,
          dest.replace(/\.po$/, '.json')
        );
        var content = nodeFs.readFileSync(sourcePath).toString();
        var json = compiler.convertPo([content]);
        nodeFs.writeFileSync(targetPath, json);
        // Add strings to gettext
        gettextCatalog.loadRemote(targetPath);
      }
      if (collection.package) {
        dest = collection.package.replace(pattern, collection.name);
        safeExtract(collection.package, dest, zip);
      }
      if (collection.readme) {
        dest = collection.readme.replace(pattern, collection.name);
        safeExtract(collection.readme, dest, zip);
      }
    }

    function safeExtract(entry, dest, zip) {
      try {
        var newPath = nodePath.join(common.INTERNAL_COLLECTIONS_DIR, dest);
        zip.extractEntryTo(
          entry,
          utils.dirname(newPath),
          /*maintainEntryPath*/ false
        );
      } catch (e) {}
    }

    this.removeCollection = function (collection) {
      utils.deleteFolderRecursive(collection.path);
      collections.loadInternalCollections();
      alertify.success(
        _tcStr('Collection {{name}} removed', {
          name: utils.bold(collection.name),
        })
      );
    };

    this.removeAllCollections = function () {
      utils.removeCollections();
      collections.loadInternalCollections();
      alertify.success(_tcStr('All collections removed'));
    };

    this.canCheckVersion =
      _package.repository !== undefined && _package.sha !== undefined;

    this.checkForNewVersion = function () {
      $.getJSON(
        _package.repository.replace('github.com', 'api.github.com/repos') +
          '/tags' +
          '?_tsi=' +
          new Date().getTime(),
        function (result) {
          if (result) {
            const latest = result
              .find((x) => x.name === 'nightly')
              .commit.sha.substring(0, 8);
            const msg =
              latest === _package.sha
                ? 'Icestudio is up to date!'
                : `Current: ${_package.sha}
              <br/>
              Latest: ${latest}<br/>
              <a class="action-open-url-external-browser" href="${_package.repository}/releases" target="_blank">Go to GitHub Releases</a>`;
            alertify.notify(
              `<div class="new-version-notifier-box">
                <div class="new-version-notifier-box--text">
                  ${msg}
                </div>
              </div>`,
              'notify',
              10
            );
          }
        }
      );
    };

    this.ifDevelopmentMode = function () {
      if (
        typeof _package.development !== 'undefined' &&
        typeof _package.development.mode !== 'undefined' &&
        _package.development.mode === true
      ) {
        utils.openDevToolsUI();
      }
    };

    this.initializePluginManager = function (callbackOnRun) {
      if (typeof ICEpm !== 'undefined') {
        console.log('ENV', common);
        ICEpm.setEnvironment(common);
        ICEpm.setPluginDir(common.DEFAULT_PLUGIN_DIR, function () {
          let plist = ICEpm.getAll();
          let uri = ICEpm.getBaseUri();
          let t = $('.icm-icon-list');
          t.empty();
          let html = '';
          for (let prop in plist) {
            if (
              typeof plist[prop].manifest.type === 'undefined' ||
              plist[prop].manifest.type === 'app'
            ) {
              html +=
                '<a href="#" data-action="icm-plugin-run" data-plugin="' +
                prop +
                '"><img class="icm-plugin-icon" src="' +
                uri +
                '/' +
                prop +
                '/' +
                plist[prop].manifest.icon +
                '"><span>' +
                plist[prop].manifest.name +
                '</span></a>';
            }
          }
          t.append(html);

          $('[data-action="icm-plugin-run"]').off();
          $('[data-action="icm-plugin-run"]').on('click', function (e) {
            e.preventDefault();
            let ptarget = $(this).data('plugin');
            if (typeof callbackOnRun !== 'undefined') {
              callbackOnRun();
            }
            ICEpm.run(ptarget);
            return false;
          });
        });
      }
    };
  });
