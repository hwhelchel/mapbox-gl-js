'use strict';

var browser = require('../util/browser');
var mat2 = require('gl-matrix').mat2;
var pixelsToTileUnits = require('../source/pixels_to_tile_units');

/**
 * Draw a line. Under the hood this will read elements from
 * a tile, dash textures from a lineAtlas, and style properties from a layer.
 * @param {Object} painter
 * @param {Object} layer
 * @param {Object} posMatrix
 * @param {Tile} tile
 * @returns {undefined} draws with the painter
 * @private
 */
module.exports = function drawLine(painter, source, layer, coords) {
    if (painter.isOpaquePass) return;
    painter.setDepthSublayer(0);
    painter.depthMask(false);

    var gl = painter.gl;
    gl.enable(gl.STENCIL_TEST);

    if (layer.paint['line-width'] <= 0) return;

    var antialiasingMatrix = mat2.create();
    mat2.scale(antialiasingMatrix, antialiasingMatrix, [1, Math.cos(painter.transform._pitch)]);
    mat2.rotate(antialiasingMatrix, antialiasingMatrix, painter.transform.angle);

    for (var k = 0; k < coords.length; k++) {
        var coord = coords[k];
        var tile = source.getTile(coord);
        var bucket = tile.getBucket(layer);
        if (!bucket) continue;
        var bufferGroups = bucket.bufferGroups.line;
        if (!bufferGroups) continue;

        var program;
        var programOptions = bucket.paintAttributes.line[layer.id];
        if (layer.paint['line-dasharray']) {
            program = bindLineSDFPatternProgram(painter, source, layer, tile, programOptions);
        } else if (layer.paint['line-pattern']) {
            program = bindLinePatternProgram(painter, source, layer, tile, programOptions);
        } else {
            program = bindLineProgram(painter, source, layer, tile, programOptions);
        }

        var posMatrix = painter.translatePosMatrix(coord.posMatrix, tile, layer.paint['line-translate'], layer.paint['line-translate-anchor']);

        painter.setUniforms({
            'u_ratio': 1 / pixelsToTileUnits(tile, 1, painter.transform.zoom),
            'u_blur': layer.paint['line-blur'] + 1 / browser.devicePixelRatio,
            'u_extra': getExtra(painter.transform),
            'u_linewidth': layer.paint['line-width'] / 2,
            'u_opacity': layer.paint['line-opacity'],
            'u_offset': -layer.paint['line-offset'],
            'u_gapwidth': layer.paint['line-gap-width'] / 2,
            'u_antialiasing': (1 / browser.devicePixelRatio) / 2
        });
        gl.uniformMatrix2fv(program.u_antialiasingmatrix, false, antialiasingMatrix);
        gl.uniformMatrix4fv(program.u_matrix, false, posMatrix);
        painter.setUniforms(bucket.getUniforms('line', program, layer, {zoom: painter.transform.zoom}));

        painter.enableTileClippingMask(coord);

        for (var i = 0; i < bufferGroups.length; i++) {
            var group = bufferGroups[i];
            group.vaos[layer.id].bind(gl, program, group.layoutVertexBuffer, group.elementBuffer, group.paintVertexBuffers[layer.id]);
            gl.drawElements(gl.TRIANGLES, group.elementBuffer.length * 3, gl.UNSIGNED_SHORT, 0);
        }
    }
};


function bindLineSDFPatternProgram(painter, source, layer, tile, programOptions) {
    var gl = painter.gl;

    var program = painter.useProgram(
        'linesdfpattern',
        programOptions.defines,
        programOptions.vertexPragmas,
        programOptions.fragmentPragmas
    );

    var dasharray = layer.paint['line-dasharray'];
    var posA = painter.lineAtlas.getDash(dasharray.from, layer.layout['line-cap'] === 'round');
    var posB = painter.lineAtlas.getDash(dasharray.to, layer.layout['line-cap'] === 'round');
    var widthA = posA.width * dasharray.fromScale;
    var widthB = posB.width * dasharray.toScale;
    painter.setUniforms({
        'u_tex_y_a': posA.y,
        'u_tex_y_b': posB.y,
        'u_mix': dasharray.t,
        'u_patternscale_a': [1 / pixelsToTileUnits(tile, widthA, painter.transform.tileZoom), -posA.height / 2],
        'u_patternscale_b': [1 / pixelsToTileUnits(tile, widthB, painter.transform.tileZoom), -posB.height / 2],
        'u_sdfgamma': painter.lineAtlas.width / (Math.min(widthA, widthB) * 256 * browser.devicePixelRatio) / 2
    });
    gl.uniform1i(program.u_image, 0);
    gl.activeTexture(gl.TEXTURE0);
    painter.lineAtlas.bind(gl);

    return program;
}

function bindLinePatternProgram(painter, source, layer, tile, programOptions) {
    var gl = painter.gl;

    var program = painter.useProgram(
        'linepattern',
        programOptions.defines,
        programOptions.vertexPragmas,
        programOptions.fragmentPragmas
    );

    var image = layer.paint['line-pattern'];
    var imagePosA = painter.spriteAtlas.getPosition(image.from, true);
    var imagePosB = painter.spriteAtlas.getPosition(image.to, true);
    if (!imagePosA || !imagePosB) return;
    painter.setUniforms({
        'u_pattern_tl_a': imagePosA.tl,
        'u_pattern_br_a': imagePosA.br,
        'u_pattern_tl_b': imagePosB.tl,
        'u_pattern_br_b': imagePosB.br,
        'u_fade': image.t,
        'u_pattern_size_a': [
            pixelsToTileUnits(tile, imagePosA.size[0] * image.fromScale, painter.transform.tileZoom),
            imagePosB.size[1]
        ],
        'u_pattern_size_b': [
            pixelsToTileUnits(tile, imagePosB.size[0] * image.toScale, painter.transform.tileZoom),
            imagePosB.size[1]
        ]
    });
    gl.uniform1i(program.u_image, 0);
    gl.activeTexture(gl.TEXTURE0);
    painter.spriteAtlas.bind(gl, true);

    return program;
}

function bindLineProgram(painter, source, layer, tile, programOptions) {
    return painter.useProgram(
        'line',
        programOptions.defines,
        programOptions.vertexPragmas,
        programOptions.fragmentPragmas
    );
}

function getExtra(transform) {
    // calculate how much longer the real world distance is at the top of the screen
    // than at the middle of the screen.
    var topedgelength = Math.sqrt(transform.height * transform.height / 4  * (1 + transform.altitude * transform.altitude));
    var x = transform.height / 2 * Math.tan(transform._pitch);
    return (topedgelength + x) / topedgelength - 1;
}
