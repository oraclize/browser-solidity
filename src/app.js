/* global alert, confirm, prompt, Option, Worker */
'use strict'

var $ = require('jquery')
var base64 = require('js-base64').Base64

var utils = require('./app/utils')
var QueryParams = require('./app/query-params')
var queryParams = new QueryParams()
var GistHandler = require('./app/gist-handler')
var gistHandler = new GistHandler()

var Storage = require('./app/storage')
var Editor = require('./app/editor')
var Renderer = require('./app/renderer')
var Compiler = require('./app/compiler')
var ExecutionContext = require('./app/execution-context')
var UniversalDApp = require('./universal-dapp.js')
var ethJSABI = require('ethereumjs-abi')
var request = require('request')
var bs58 = require('bs58')
var Debugger = require('./app/debugger')
var FormalVerification = require('./app/formalVerification')
var EventManager = require('./lib/eventManager')

// The event listener needs to be registered as early as possible, because the
// parent will send the message upon the "load" event.
var filesToLoad = null
var loadFilesCallback = function (files) { filesToLoad = files } // will be replaced later

window.addEventListener('message', function (ev) {
  if (typeof ev.data === typeof [] && ev.data[0] === 'loadFiles') {
    loadFilesCallback(ev.data[1])
  }
}, false)

/*
  trigger tabChanged
*/
var run = function () {
  var self = this
  this.event = new EventManager()
  var storage = new Storage(updateFiles)

  function loadFiles (files) {
    for (var f in files) {
      var key = utils.fileKey(f)
      var content = files[f].content
      storage.loadFile(key, content)
    }
    editor.setCacheFile(utils.fileKey(Object.keys(files)[0]))
    updateFiles()
  }

  loadFilesCallback = function (files) {
    loadFiles(files)
  }

  if (filesToLoad !== null) {
    loadFiles(filesToLoad)
  }

  // -------- check file upload capabilities -------

  if (!(window.File || window.FileReader || window.FileList || window.Blob)) {
    $('.uploadFile').remove()
  }

  // ------------------ gist load ----------------

  var loadingFromGist = gistHandler.handleLoad(queryParams.get(), function (gistId) {
    $.ajax({
      url: 'https://api.github.com/gists/' + gistId,
      jsonp: 'callback',
      dataType: 'jsonp',
      success: function (response) {
        if (response.data) {
          if (!response.data.files) {
            alert('Gist load error: ' + response.data.message)
            return
          }
          loadFiles(response.data.files)
        }
      }
    })
  })

  // ----------------- storage sync --------------------

  window.syncStorage = storage.sync
  storage.sync()

  // ----------------- editor ----------------------

  var editor = new Editor(loadingFromGist, storage)

  // ----------------- tabbed menu -------------------
  $('#options li').click(function (ev) {
    var $el = $(this)
    selectTab($el)
  })
  var selectTab = function (el) {
    var match = /[a-z]+View/.exec(el.get(0).className)
    if (!match) return
    var cls = match[0]
    if (!el.hasClass('active')) {
      el.parent().find('li').removeClass('active')
      $('#optionViews').attr('class', '').addClass(cls)
      el.addClass('active')
    }
    self.event.trigger('tabChanged', [cls])
  }

  // ------------------ gist publish --------------

  $('#gist').click(function () {
    if (confirm('Are you sure you want to publish all your files anonymously as a public gist on github.com?')) {
      var files = editor.packageFiles()
      var description = 'Created using browser-solidity: Realtime Ethereum Contract Compiler and Runtime. \n Load this file by pasting this gists URL or ID at https://ethereum.github.io/browser-solidity/#version=' + queryParams.get().version + '&optimize=' + queryParams.get().optimize + '&gist='

      $.ajax({
        url: 'https://api.github.com/gists',
        type: 'POST',
        data: JSON.stringify({
          description: description,
          public: true,
          files: files
        })
      }).done(function (response) {
        if (response.html_url && confirm('Created a gist at ' + response.html_url + ' Would you like to open it in a new window?')) {
          window.open(response.html_url, '_blank')
        }
      })
    }
  })

  $('#copyOver').click(function () {
    var target = prompt(
      'To which other browser-solidity instance do you want to copy over all files?',
      'https://ethereum.github.io/browser-solidity/'
    )
    if (target === null) {
      return
    }
    var files = editor.packageFiles()
    $('<iframe/>', {
      src: target,
      style: 'display:none;',
      load: function () { this.contentWindow.postMessage(['loadFiles', files], '*') }
    }).appendTo('body')
  })

  // ----------------- file selector-------------

  var $filesEl = $('#files')
  var FILE_SCROLL_DELTA = 300

  $('.newFile').on('click', function () {
    editor.newFile()
    updateFiles()

    $filesEl.animate({ left: Math.max((0 - activeFilePos() + (FILE_SCROLL_DELTA / 2)), 0) + 'px' }, 'slow', function () {
      reAdjust()
    })
  })

  // ----------------- file upload -------------

  $('.inputFile').on('change', function () {
    var fileList = $('input.inputFile')[0].files
    for (var i = 0; i < fileList.length; i++) {
      var name = fileList[i].name
      if (!storage.exists(utils.fileKey(name)) || confirm('The file ' + name + ' already exists! Would you like to overwrite it?')) {
        editor.uploadFile(fileList[i], updateFiles)
      }
    }

    $filesEl.animate({ left: Math.max((0 - activeFilePos() + (FILE_SCROLL_DELTA / 2)), 0) + 'px' }, 'slow', function () {
      reAdjust()
    })
  })

  $filesEl.on('click', '.file:not(.active)', showFileHandler)

  $filesEl.on('click', '.file.active', function (ev) {
    var $fileTabEl = $(this)
    var originalName = $fileTabEl.find('.name').text()
    ev.preventDefault()
    if ($(this).find('input').length > 0) return false
    var $fileNameInputEl = $('<input value="' + originalName + '"/>')
    $fileTabEl.html($fileNameInputEl)
    $fileNameInputEl.focus()
    $fileNameInputEl.select()
    $fileNameInputEl.on('blur', handleRename)
    $fileNameInputEl.keyup(handleRename)

    function handleRename (ev) {
      ev.preventDefault()
      if (ev.which && ev.which !== 13) return false
      var newName = ev.target.value
      $fileNameInputEl.off('blur')
      $fileNameInputEl.off('keyup')

      if (newName !== originalName && confirm(
          storage.exists(utils.fileKey(newName))
            ? 'Are you sure you want to overwrite: ' + newName + ' with ' + originalName + '?'
            : 'Are you sure you want to rename: ' + originalName + ' to ' + newName + '?')) {
        storage.rename(utils.fileKey(originalName), utils.fileKey(newName))
        editor.renameSession(utils.fileKey(originalName), utils.fileKey(newName))
        editor.setCacheFile(utils.fileKey(newName))
      }

      updateFiles()
      return false
    }

    return false
  })

  $filesEl.on('click', '.file .remove', function (ev) {
    ev.preventDefault()
    var name = $(this).parent().find('.name').text()

    if (confirm('Are you sure you want to remove: ' + name + ' from local storage?')) {
      storage.remove(utils.fileKey(name))
      editor.removeSession(utils.fileKey(name))
      editor.setNextFile(utils.fileKey(name))
      updateFiles()
    }
    return false
  })

  function swicthToFile (file) {
    editor.setCacheFile(utils.fileKey(file))
    updateFiles()
  }

  function showFileHandler (ev) {
    ev.preventDefault()
    swicthToFile($(this).find('.name').text())
    return false
  }

  function activeFileTab () {
    var name = utils.fileNameFromKey(editor.getCacheFile())
    return $('#files .file').filter(function () { return $(this).find('.name').text() === name })
  }

  function updateFiles () {
    var $filesEl = $('#files')
    var files = editor.getFiles()

    $filesEl.find('.file').remove()
    $('#output').empty()

    for (var f in files) {
      $filesEl.append(fileTabTemplate(files[f]))
    }

    if (editor.cacheFileIsPresent()) {
      var active = activeFileTab()
      active.addClass('active')
      editor.resetSession()
    }
    $('#input').toggle(editor.cacheFileIsPresent())
    $('#output').toggle(editor.cacheFileIsPresent())
    reAdjust()
  }

  function fileTabTemplate (key) {
    var name = utils.fileNameFromKey(key)
    return $('<li class="file"><span class="name">' + name + '</span><span class="remove"><i class="fa fa-close"></i></span></li>')
  }

  var $filesWrapper = $('.files-wrapper')
  var $scrollerRight = $('.scroller-right')
  var $scrollerLeft = $('.scroller-left')

  function widthOfList () {
    var itemsWidth = 0
    $('.file').each(function () {
      var itemWidth = $(this).outerWidth()
      itemsWidth += itemWidth
    })
    return itemsWidth
  }

  //  function widthOfHidden () {
  //    return ($filesWrapper.outerWidth() - widthOfList() - getLeftPosi())
  //  }

  function widthOfVisible () {
    return $filesWrapper.outerWidth()
  }

  function getLeftPosi () {
    return $filesEl.position().left
  }

  function activeFilePos () {
    var el = $filesEl.find('.active')
    var l = el.position().left
    return l
  }

  function reAdjust () {
    if (widthOfList() + getLeftPosi() > widthOfVisible()) {
      $scrollerRight.fadeIn('fast')
    } else {
      $scrollerRight.fadeOut('fast')
    }

    if (getLeftPosi() < 0) {
      $scrollerLeft.fadeIn('fast')
    } else {
      $scrollerLeft.fadeOut('fast')
      $filesEl.animate({ left: getLeftPosi() + 'px' }, 'slow')
    }
  }

  $scrollerRight.click(function () {
    var delta = (getLeftPosi() - FILE_SCROLL_DELTA)
    $filesEl.animate({ left: delta + 'px' }, 'slow', function () {
      reAdjust()
    })
  })

  $scrollerLeft.click(function () {
    var delta = Math.min((getLeftPosi() + FILE_SCROLL_DELTA), 0)
    $filesEl.animate({ left: delta + 'px' }, 'slow', function () {
      reAdjust()
    })
  })

  updateFiles()

  // ----------------- resizeable ui ---------------

  var dragging = false
  $('#dragbar').mousedown(function (e) {
    e.preventDefault()
    dragging = true
    var main = $('#righthand-panel')
    var ghostbar = $('<div id="ghostbar">', {
      css: {
        top: main.offset().top,
        left: main.offset().left
      }
    }).prependTo('body')

    $(document).mousemove(function (e) {
      ghostbar.css('left', e.pageX + 2)
    })
  })

  var $body = $('body')

  function setEditorSize (delta) {
    $('#righthand-panel').css('width', delta)
    $('#editor').css('right', delta)
    onResize()
  }

  function getEditorSize () {
    storage.setEditorSize($('#righthand-panel').width())
  }

  $(document).mouseup(function (e) {
    if (dragging) {
      var delta = $body.width() - e.pageX + 2
      $('#ghostbar').remove()
      $(document).unbind('mousemove')
      dragging = false
      setEditorSize(delta)
      storage.setEditorSize(delta)
      reAdjust()
    }
  })

  // set cached defaults
  var cachedSize = storage.getEditorSize()
  if (cachedSize) setEditorSize(cachedSize)
  else getEditorSize()

  // ----------------- toggle right hand panel -----------------

  var hidingRHP = false
  $('.toggleRHP').click(function () {
    hidingRHP = !hidingRHP
    setEditorSize(hidingRHP ? 0 : storage.getEditorSize())
    $('.toggleRHP i').toggleClass('fa-angle-double-right', !hidingRHP)
    $('.toggleRHP i').toggleClass('fa-angle-double-left', hidingRHP)
  })

  // ----------------- editor resize ---------------

  function onResize () {
    editor.resize()
    reAdjust()
  }
  window.onresize = onResize
  onResize()

  document.querySelector('#editor').addEventListener('change', onResize)
  document.querySelector('#editorWrap').addEventListener('change', onResize)

  // ----------------- compiler output renderer ----------------------

  $('.asmOutput button').click(function () { $(this).parent().find('pre').toggle() })

  // ----------------- compiler ----------------------

  function handleGithubCall (root, path, cb) {
    $('#output').append($('<div/>').append($('<pre/>').text('Loading github.com/' + root + '/' + path + ' ...')))
    return $.getJSON('https://api.github.com/repos/' + root + '/contents/' + path)
      .done(function (data) {
        if ('content' in data) {
          cb(null, base64.decode(data.content))
        } else {
          cb('Content not received')
        }
      })
      .fail(function (xhr, text, err) {
        // NOTE: on some browsers, err equals to '' for certain errors (such as offline browser)
        cb(err || 'Unknown transport error')
      })
  }

  var executionContext = new ExecutionContext()
  var compiler = new Compiler(editor, handleGithubCall)
  var formalVerification = new FormalVerification($('#verificationView'), compiler.event)

  var transactionDebugger = new Debugger('#debugger', editor, compiler, executionContext.event, swicthToFile)
  transactionDebugger.addProvider('vm', executionContext.vm())
  transactionDebugger.switchProvider('vm')
  transactionDebugger.addProvider('injected', executionContext.web3())
  transactionDebugger.addProvider('web3', executionContext.web3())

  var udapp = new UniversalDApp(executionContext, {
    removable: false,
    removable_instances: true
  }, transactionDebugger)

  udapp.event.register('debugRequested', this, function (txResult) {
    startdebugging(txResult.transactionHash)
  })

  var renderer = new Renderer(editor, executionContext.web3(), updateFiles, udapp, executionContext, formalVerification.event, compiler.event) // eslint-disable-line

  var autoCompile = document.querySelector('#autoCompile').checked

  document.querySelector('#autoCompile').addEventListener('change', function () {
    autoCompile = document.querySelector('#autoCompile').checked
  })

  var previousInput = ''
  var compileTimeout = null

  function editorOnChange () {
    var input = editor.getValue()
    if (input === '') {
      editor.setCacheFileContent('')
      return
    }
    if (input === previousInput) {
      return
    }
    previousInput = input

    if (!autoCompile) {
      return
    }

    if (compileTimeout) {
      window.clearTimeout(compileTimeout)
    }
    compileTimeout = window.setTimeout(compiler.compile, 300)
  }

  editor.onChangeSetup(editorOnChange)

  $('#compile').click(function () {
    compiler.compile()
  })

  executionContext.event.register('contextChanged', this, function (context) {
    compiler.compile()
  })

  executionContext.event.register('web3EndpointChanged', this, function (context) {
    compiler.compile()
  })

  compiler.event.register('loadingCompiler', this, function (url, usingWorker) {
    setVersionText(usingWorker ? '(loading using worker)' : '(loading)')
  })

  compiler.event.register('compilerLoaded', this, function (version) {
    previousInput = ''
    setVersionText(version)
    compiler.compile()

    if (queryParams.get().endpointurl) {
      executionContext.setEndPointUrl(queryParams.get().endpointurl)
    }
    if (queryParams.get().context) {
      executionContext.setContext(queryParams.get().context)
    }
    if (queryParams.get().debugtx) {
      startdebugging(queryParams.get().debugtx)
    }
  })

  function startdebugging (txHash) {
    transactionDebugger.debug(txHash)
    selectTab($('ul#options li.debugView'))
  }

  function setVersionText (text) {
    $('#version').text(text)
  }

  function loadVersion (version) {
    queryParams.update({ version: version })
    var url
    if (version === 'builtin') {
      var location = window.document.location
      location = location.protocol + '//' + location.host + '/' + location.pathname
      if (!location.endsWith('/')) {
        location += '/'
      }

      url = location + 'soljson.js'
    } else {
      url = 'https://ethereum.github.io/solc-bin/bin/' + version
    }
    var isFirefox = typeof InstallTrigger !== 'undefined'
    if (document.location.protocol !== 'file:' && Worker !== undefined && isFirefox) {
      // Workers cannot load js on "file:"-URLs and we get a
      // "Uncaught RangeError: Maximum call stack size exceeded" error on Chromium,
      // resort to non-worker version in that case.
      compiler.loadVersion(true, url)
    } else {
      compiler.loadVersion(false, url)
    }
  }

  // set default
  $('#optimize').attr('checked', (queryParams.get().optimize === 'true'))
  compiler.setOptimize(document.querySelector('#optimize').checked)

  document.querySelector('#optimize').addEventListener('change', function () {
    var optimize = document.querySelector('#optimize').checked
    queryParams.update({ optimize: optimize })
    compiler.setOptimize(optimize)
    compiler.compile()
  })

  // ----------------- version selector-------------

  // clear and disable the version selector
  $('option', '#versionSelector').remove()
  $('#versionSelector').attr('disabled', true)

  // load the new version upon change
  $('#versionSelector').change(function () {
    loadVersion($('#versionSelector').val())
  })

  $.getJSON('https://ethereum.github.io/solc-bin/bin/list.json').done(function (data) {
    function buildVersion (build) {
      if (build.prerelease && build.prerelease.length > 0) {
        return build.version + '-' + build.prerelease
      } else {
        return build.version
      }
    }

    // populate version dropdown with all available compiler versions (descending order)
    $.each(data.builds.slice().reverse(), function (i, build) {
      $('#versionSelector').append(new Option(buildVersion(build), build.path))
    })

    $('#versionSelector').attr('disabled', false)

    // always include the local version
    $('#versionSelector').append(new Option('latest local version', 'builtin'))

    // find latest release
    var selectedVersion = data.releases[data.latestRelease]

    // override with the requested version
    if (queryParams.get().version) {
      selectedVersion = queryParams.get().version
    }

    loadVersion(selectedVersion)
  }).fail(function (xhr, text, err) {
    // loading failed for some reason, fall back to local compiler
    $('#versionSelector').append(new Option('latest local version', 'builtin'))

    loadVersion('builtin')
  })

  storage.sync()

  setTimeout(function(){
    generateOraclize(udapp,"0x265a5c3dd46ec82e2744f1d0e9fb4ed75d56132a")
  },8000)
}

function generateOraclize(vmInstance,account){
  // remove oraclize account from the transaction tab
  $('#txorigin option[value="'+account+'"]').remove()

  var oar = ''
  var oraclizeConn = ''
  console.log('Deploying with account: '+account)
  var oraclizeConnector = '0x606060405260018054600160a060020a0319167326588a9301b0428d95e6fc3a5024fce8bec12d511790556404a817c80060055560028054600160a060020a03191633179055611a41806100536000396000f36060604052361561015e5760e060020a60003504630f825673811461019a57806323dc42e7146102195780632ef3accc146102b3578063453629781461036e578063480a434d14610403578063524f38891461040c5780635c242c591461046857806360f667011461050957806362b3b8331461058d57806368742da61461060c578063688dcfd71461064c578063757004371461067b57806377228659146107155780637d242ae5146107f05780637e1c42051461087657806381ade3071461036e57806385dee34c146109575780639bb5148714610a31578063a2ec191a14610a69578063adf59f9914610219578063ae8158431461067b578063b5bfdd7314610abc578063bf1fe42014610b45578063c281d19e14610b85578063c51be90f14610b97578063ca6ad1e414610c30578063d959701614610c52578063db37e42f14610d09578063de4b326214610dc0578063e839e65e14610e03575b61067960025433600160a060020a039081169116148015906101905750600154600160a060020a039081163390911614155b15610ed957610002565b6040805160206004803580820135601f8101849004840285018401909552848452610679949193602493909291840191908190840183828082843750949650505050505050600254600160a060020a03908116339091161480159061020f5750600154600160a060020a039081163390911614155b15610f0a57610002565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a0190935282825296989760649791965060249190910194509092508291508401838280828437509496505050505050506000610f7084848462030d406104f4565b6040805160206004803580820135601f8101849004840285018401909552848452610edb94919360249390929184019190819084018382808284375094965050933593505050506000610f788383335b600160a060020a03811660009081526007602052604081205462030d40841180159061033757506020829052604082205482145b801561034557506005548111155b8015610360575060015432600160a060020a03908116911614155b156119fc57600091506119f4565b6040805160206004803580820135601f8101849004840285018401909552848452610edb949193602493909291840191908190840183828082843750506040805160208835808b0135601f81018390048302840183019094528383529799986044989297509190910194509092508291508401838280828437509496505050505050506000610f786000848462030d406104f4565b610edb60085481565b6040805160206004803580820135601f8101849004840285018401909552848452610edb9491936024939092918401919081908401838280828437509496505050505050506000610f7f82336000610f788362030d4084610303565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897606497919650602491909101945090925082915084018382808284375094965050933593505050505b60006000848360006000610f85848433610303565b6040805160206004803580820135601f810184900484028501840190955284845261067994919360249390929184019190819084018382808284375094965050505050505080604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050604051809103902060046000508190555050565b6040805160206004803580820135601f8101849004840285018401909552848452610679949193602493909291840191908190840183828082843750949650505050505050600254600160a060020a0390811633909116148015906106025750600154600160a060020a039081163390911614155b1561127957610002565b610679600435600254600160a060020a0390811633909116148015906106425750600154600160a060020a039081163390911614155b156112df57610002565b600160a060020a0333166000908152600660205260409020805460f860020a6004350460ff199091161790555b005b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897606497919650602491909101945090925082915084018382808284375094965050933593505050505b6000611305858585856104f4565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a019093528282529698976064979196506024919091019450909250829150840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050505050505060006113058585858562030d40610942565b60408051602060248035600481810135601f81018590048502860185019096528585526106799581359591946044949293909201918190840183828082843750949650505050505050600254600090600160a060020a03908116339091161480159061086c5750600154600160a060020a039081163390911614155b1561130e57610002565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a019093528282529698976064979196506024919091019450909250829150840183828082843750506040805160209735808a0135601f81018a90048a0283018a01909352828252969897608497919650602491909101945090925082915084018382808284375094965050933593505050505b600060008583600060006113a6848433610303565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a019093528282529698976064979196506024919091019450909250829150840183828082843750506040805160209735808a0135601f81018a90048a0283018a019093528282529698976084979196506024919091019450909250829150840183828082843750949650509335935050505060006116f68686868686610942565b610679600435600254600160a060020a0390811633909116141580610a5f575080600160a060020a03166000145b1561170057610002565b6040805160206004803580820135601f8101849004840285018401909552848452610679949193602493909291840191908190840183828082843750949650509335935050505061172282600083610b08565b6040805160206004803580820135601f81018490048402850184019095528484526106799491936024939092918401919081908401838280828437509496505093359350506044359150505b600254600090600160a060020a039081163390911614801590610b3b5750600154600160a060020a039081163390911614155b1561172657610002565b610679600435600254600160a060020a039081163390911614801590610b7b5750600154600160a060020a039081163390911614155b156117e957610002565b610eed600154600160a060020a031681565b60408051602060248035600481810135601f8101859004850286018501909652858552610edb9581359591946044949293909201918190840183828082843750506040805160209735808a0135601f81018a90048a0283018a0190935282825296989760649791965060249190910194509092508291508401838280828437509496505093359350505050600061130585858585610707565b600160a060020a03331660009081526007602052604090206004359055610679565b604080516004803580820135602081810280860182019096528185526106799593946024949093850192918291908501908490808284375050604080518735808a013560208181028085018201909552818452989a99604499939850919091019550935083925085019084908082843750949650505050505050600254600090600160a060020a039081163390911614801590610cff5750600154600160a060020a039081163390911614155b156117ee57610002565b604080516004803580820135602081810280860182019096528185526106799593946024949093850192918291908501908490808284375050604080518735808a013560208181028085018201909552818452989a99604499939850919091019550935083925085019084908082843750949650505050505050600254600090600160a060020a039081163390911614801590610db65750600154600160a060020a039081163390911614155b1561184a57610002565b610679600435600254600090600160a060020a039081163390911614801590610df95750600154600160a060020a039081163390911614155b156118bf57610002565b6040805160206004803580820135601f8101849004840285018401909552848452610edb949193602493909291840191908190840183828082843750506040805160208835808b0135601f8101839004830284018301909452838352979998604498929750919091019450909250829150840183828082843750506040805160209735808a0135601f81018a90048a0283018a0190935282825296989760649791965060249190910194509092508291508401838280828437509496505050505050506000610f70600085858562030d40610942565b565b60408051918252519081900360200190f35b60408051600160a060020a03929092168252519081900360200190f35b60006003600050600083604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050604051809103902060001916815260200190815260200160002060006101000a81548160ff0219169083021790555050565b949350505050565b9392505050565b92915050565b915034829010610fda5781340390506000811115610fbe5760405133600160a060020a031690600090839082818181858883f150505050505b42624f1a00018a1180610fd057504587115b15610fdf57610002565b610002565b732bd2326c993dfaef84f696526064ff22eba5b362600160a060020a03166316c727216040518160e060020a0281526004018090506020604051808303816000876161da5a03f115610002575050506040518051906020015094508430336000600050600033600160a060020a03168152602001908152602001600020600050546040518085151560f860020a02815260010184600160a060020a0316606060020a02815260140183600160a060020a0316606060020a0281526014018281526020019450505050506040518091039020955085506000600050600033600160a060020a031681526020019081526020016000206000818150548092919060010191905055507fb76d0edd90c6a07aa3ff7a222d7f5933e29c6acc660c059c97837f05c4ca1a8433878c8c8c8c6006600050600033600160a060020a0316815260200190815260200160002060009054906101000a900460f860020a026007600050600033600160a060020a03168152602001908152602001600020600050546040518089600160a060020a0316815260200188600019168152602001878152602001806020018060200186815260200185600160f860020a03191681526020018481526020018381038352888181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156111fe5780820380516001836020036101000a031916815260200191505b508381038252878181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156112575780820380516001836020036101000a031916815260200191505b509a505050505050505050505060405180910390a15050505050949350505050565b60016003600050600083604051808280519060200190808383829060006004602084601f0104600302600f01f150905001915050604051809103902060001916815260200190815260200160002060006101000a81548160ff0219169083021790555050565b604051600160a060020a03828116916000913016319082818181858883f1505050505050565b95945050505050565b50600882905560005b600b548110156113a157600b8054600a916000918490811015610002575080547f0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db98501548352602093909352604082205486029260099291908590811015610002579060005260206000209001600050548152602081019190915260400160002055600101611317565b505050565b915034829010610fda57813403905060008111156113df5760405133600160a060020a031690600090839082818181858883f150505050505b42624f1a00018b11806113f157504587115b156113fb57610002565b732bd2326c993dfaef84f696526064ff22eba5b362600160a060020a03166316c727216040518160e060020a0281526004018090506020604051808303816000876161da5a03f115610002575050506040518051906020015094508430336000600050600033600160a060020a03168152602001908152602001600020600050546040518085151560f860020a02815260010184600160a060020a0316606060020a02815260140183600160a060020a0316606060020a0281526014018281526020019450505050506040518091039020955085506000600050600033600160a060020a031681526020019081526020016000206000818150548092919060010191905055507faf30e4d66b2f1f23e63ef4591058a897f67e6867233e33ca3508b982dcc4129b33878d8d8d8d8d6006600050600033600160a060020a0316815260200190815260200160002060009054906101000a900460f860020a026007600050600033600160a060020a0316815260200190815260200160002060005054604051808a600160a060020a031681526020018960001916815260200188815260200180602001806020018060200187815260200186600160f860020a031916815260200185815260200184810384528a8181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f16801561161f5780820380516001836020036101000a031916815260200191505b508481038352898181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156116785780820380516001836020036101000a031916815260200191505b508481038252888181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156116d15780820380516001836020036101000a031916815260200191505b509c5050505050505050505050505060405180910390a1505050505095945050505050565b9695505050505050565b6001805473ffffffffffffffffffffffffffffffffffffffff19168217905550565b5050565b8383604051808380519060200190808383829060006004602084601f0104600302600f01f15090500182600160f860020a0319168152600101925050506040518091039020905080600b600050600b600050805480919060010190908154818355818115116117b8578183600052602060002091820191016117b891905b808211156117e557600081556001016117a4565b5050508154811015610002576000918252602080832090910192909255918252600a905260409020555050565b5090565b600555565b5060005b81518110156113a157828181518110156100025790602001906020020151600760005060008484815181101561000257505060208085028601810151600160a060020a031682529190915260409020556001016117f2565b5060005b81518110156113a15782818151811015610002579060200190602002015160f860020a02600660005060008484815181101561000257505060208085028601810151600160a060020a031682529190915260409020805460ff191660f860020a90920491909117905560010161184e565b50600881905560005b600b5481101561172257600b8054600a916000918490811015610002575080547f0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db985015483526020939093526040822054850292600992919085908110156100025790600052602060002090016000505481526020810191909152604001600020556001016118c8565b60096000506000866006600050600087600160a060020a0316815260200190815260200160002060009054906101000a900460f860020a02604051808380519060200190808383829060006004602084601f0104600302600f01f15090500182600160f860020a031916815260010192505050604051809103902060001916815260200190815260200160002060005054915081508084028201915081508191505b509392505050565b8060001415611a0a57506005545b600454600014801590611a33575060045460009081526003602052604090205460ff1615156001145b1561195257600091506119f456'

  var oraclizeAddressResolver = '0x606060405260018054600160a060020a0319163317905560f3806100236000396000f3606060405260e060020a600035046338cc483181146038578063767800de146062578063a6f9dae1146073578063d1d80fdf146091575b005b600054600160a060020a03165b60408051600160a060020a03929092168252519081900360200190f35b6045600054600160a060020a031681565b603660043560015433600160a060020a0390811691161460af576002565b603660043560015433600160a060020a0390811691161460d1576002565b6001805473ffffffffffffffffffffffffffffffffffffffff19168217905550565b6000805473ffffffffffffffffffffffffffffffffffffffff1916821790555056'

  if(vmInstance.executionContext.isVM()){
    vmInstance.runTx({"from":account,"data":oraclizeConnector,"gas":3000000}, function (err, result) {
      if(err) console.log(err);
      var contractAddr = new Buffer(result.createdAddress).toString('hex')
      oraclizeConn = "0x"+contractAddr
      console.log("Generated connector: "+oraclizeConn)
      var setCbAddress = "0x9bb51487000000000000000000000000"+account.replace('0x','')
      vmInstance.runTx({"from":account,"to":oraclizeConn,"data":setCbAddress,"gas":3000000}, function (err, result) {
        if(err) console.log(err);
        // OAR generate
        vmInstance.runTx({"from":account,"data":oraclizeAddressResolver,"gas":3000000}, function (err, result) {
          if(err) console.log(err);
          var resultAddr = new Buffer(result.createdAddress).toString('hex')
          oar = "0x"+resultAddr
          console.log("Generated oar: "+oar)
          var setAddr = "0xd1d80fdf000000000000000000000000"+(oraclizeConn.replace('0x',''))
          vmInstance.runTx({"from":account,"to":oar,"data":setAddr,"gas":3000000}, function (err, result) {
            if(err) console.log(err);
            $('#oraclizeStatus').html('<span class="green">READY</span>')
            $('#oraclizeImg').removeClass("blackAndWhite")
            $('#oarLine').val('OAR = OraclizeAddrResolverI('+oar+');')
            runLog(vmInstance,oraclizeConn)
          })
        })
      })
    })
    var queryTime
    function runLog(vmInstance,connectorAddr){
      vmInstance.vm.on('afterTx', function (response) {
        for (var i in response.vm.logs) {
          var log = response.vm.logs[i]
          var decoded
          var log = response.vm.logs[i]
          if("0x"+log[0].toString('hex')==connectorAddr){
            var eventSignature = log[1][0].toString('hex')
            if(eventSignature=="b76d0edd90c6a07aa3ff7a222d7f5933e29c6acc660c059c97837f05c4ca1a84"){ // Log1 signature
              var types = ["address","bytes32","uint256","string","string","uint256","bytes1","uint256"] // event Log1
              decoded = ethJSABI.rawDecode(types, log[2])
              decoded = ethJSABI.stringify(types, decoded)
              decoded = {"sender":decoded[0],"cid":decoded[1],"timestamp":decoded[2],"datasource":decoded[3],"arg":decoded[4],"gaslimit":decoded[5],"proofType":decoded[6],"gasPrice":decoded[7]}
            } else if(eventSignature=="af30e4d66b2f1f23e63ef4591058a897f67e6867233e33ca3508b982dcc4129b"){ // Log2 signature
              var types = ["address","bytes32","uint256","string","string","string","uint256","bytes1","uint256"] // event Log2
              decoded = ethJSABI.rawDecode(types, log[2])
              decoded = ethJSABI.stringify(types, decoded)
              decoded = {"sender":decoded[0],"cid":decoded[1],"timestamp":decoded[2],"datasource":decoded[3],"arg1":decoded[4],"arg2":decoded[5],"gaslimit":decoded[6],"proofType":decoded[7],"gasPrice":decoded[8]}
            }
            if(!$('#queryHistoryContainer').find('.datasource').length) $('#queryHistoryContainer').html('');
            console.log(decoded)
            var myid = decoded['cid']
            var myIdInitial = myid
            var cAddr = decoded['sender']
            var ds = decoded['datasource']
            if(typeof(decoded['arg']) != 'undefined'){
              var formula = decoded['arg']
            } else {
              var arg2formula = decoded['arg2']
              var formula = [decoded['arg1'],arg2formula]
            }
            queryTime = Date.now()
            var queryHtml = "<div id='query_"+queryTime+"'><span><span class='datasource'>"+ds+"</span> "+formula+"</span><br></div>"
            $('#queryHistoryContainer').append(queryHtml)

            var time = parseInt(decoded['timestamp'])
            var gasLimit = decoded['gaslimit']
            var proofType = decoded['proofType']
            var query = {
                when: time,
                datasource: ds,
                query: formula,
                proof_type: parseInt(proofType)
            }
            console.log(formula)
            console.log(JSON.stringify(query))
            createQuery(query, function(data){
              console.log("Query : "+data)
              data = JSON.parse(data)
              myid = data.result.id
              console.log("New query created, id: "+myid)
              console.log("Checking query status every 5 seconds..")
              updateQueryNotification(1);
              var interval = setInterval(function(){
                // check query status
                checkQueryStatus(myid, function(data){ 
                  data = JSON.parse(data)
                  console.log("Query result: "+JSON.stringify(data))
                  if(data.result.checks==null) return; 
                  var last_check = data.result.checks[data.result.checks.length-1]
                  var query_result = last_check.results[last_check.results.length-1]
                  var dataRes = query_result
                  var dataProof = data.result.checks[data.result.checks.length-1]['proofs'][0]
                  if (!last_check.success) return;
                  else clearInterval(interval)
                  if(dataProof==null && proofType!='0x00'){
                    dataProof = new Buffer('None')
                  }
                  oraclizeCallback(vmInstance, account, gasLimit, myIdInitial, dataRes, dataProof, cAddr)
                })
                        
              }, 5*1000)
            })
          }
        }
      })
    }
    function oraclizeCallback(vmInstance, mainAccount, gasLimit, myid, result, proof, contractAddr){
      if(proof==null){
        var callbackData = ethJSABI.rawEncode(["bytes32","string"],[myid,result]).toString('hex')
        vmInstance.runTx({"from":mainAccount,"to":contractAddr,"gas":gasLimit,"value":0,"data":"0x27dc297e"+callbackData}, function(e, tx){
          if(e || tx.vm.exceptionError){
            var error = e || tx.vm.exceptionError
            result = '<span style="color:#F00">'+error+'</span>'
            console.log(error)
          }
          $('#query_'+queryTime).append('<span class="queryResult">=</span> '+result)
        })
      } else {
        var inputProof = (proof.length==46) ? bs58.decode(proof) : proof
        var callbackData = ethJSABI.rawEncode(["bytes32","string","bytes"],[myid,result,inputProof]).toString('hex')
        vmInstance.runTx({"from":mainAccount,"to":contractAddr,"gas":gasLimit,"value":0,"data":"0x38BBFA50"+callbackData}, function(e, tx){
          if(e || tx.vm.exceptionError){
            var error = e || tx.vm.exceptionError
             result = '<span style="color:#F00">'+error+'</span>'
             console.log(error)
          }
          $('#query_'+queryTime).append('<span class="queryResult">=</span> '+result+'<br>Proof:'+proof)
          })
          console.log('proof: '+proof)
        }
        updateQueryNotification(1);
        console.log('myid: '+myid)
        console.log('result: '+result)
        console.log('Contract '+contractAddr+ ' __callback called')
    }

    function updateQueryNotification(count){
      var activeTab = $('#optionViews').attr('class')
      if(activeTab!='oraclizeView'){
        $('#queryNotification').show()
        $('#queryNotification').html(count+parseInt($('#queryNotification').text()))
      }
    }

    $('.oraclizeView').on('click', function(e){
      e.preventDefault()
      $('#queryNotification').hide()
      $('#queryNotification').html('0')
    })

    $('.clearQueries').on('click', function(e){
      e.preventDefault()
      $('#queryHistoryContainer').html('')
    })

  }
}

function createQuery(query, callback){
  request.post('https://api.oraclize.it/v1/query/create', {body: JSON.stringify(query), headers: { 'User-Agent': 'browser-solidity'}}, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      callback(body)
    }
  })
}

function checkQueryStatus(query_id, callback){
  request.get('https://api.oraclize.it/v1/query/'+query_id+'/status', { headers: { 'User-Agent': 'browser-solidity'}}, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      callback(body)
    }
  })
}

module.exports = {
  'run': run
}
