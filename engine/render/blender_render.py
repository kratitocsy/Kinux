# Blender side of `node engine/render.mjs`: render a run's 3D board with each
# part tinted by what the run found. Run by Kinux as:
#   blender -b --factory-startup -noaudio --python-exit-code 1 --python blender_render.py -- \
#       <board.glb> <tints.json> <out.png> <samples> <width> <height>
# tints.json maps a part reference to an RGB colour. Nothing here invents a
# value: the colours come from the run's report, chosen by render.mjs.
import bpy, json, sys, mathutils

argv = sys.argv[sys.argv.index('--') + 1:]
glb, tints_path, out_png = argv[0], argv[1], argv[2]
samples, width, height = int(argv[3]), int(argv[4]), int(argv[5])
tints = json.load(open(tints_path))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)

def descendants(ob):
    out = [ob]
    for c in ob.children:
        out += descendants(c)
    return out

tinted = []
for ob in list(bpy.data.objects):
    rgb = tints.get(ob.name)
    if rgb is None:
        continue
    for m in descendants(ob):
        if m.type != 'MESH':
            continue
        for slot in m.material_slots:
            if slot.material is None:
                continue
            mat = slot.material.copy()
            slot.material = mat
            if not mat.use_nodes:
                continue
            bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if bsdf is None:
                continue
            key = 'Emission Color' if 'Emission Color' in bsdf.inputs else 'Emission'
            bsdf.inputs[key].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
            if 'Emission Strength' in bsdf.inputs:
                bsdf.inputs['Emission Strength'].default_value = 2.5
    tinted.append(ob.name)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre, size = (lo + hi) / 2, (hi - lo).length

scene = bpy.context.scene
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 50
cam_data.clip_start, cam_data.clip_end = size / 100, size * 50
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
# glTF is Y-up; Blender imports it Z-up: look down at the board from a corner.
cam.location = centre + mathutils.Vector((size * 0.7, -size * 0.95, size * 1.05))
target = bpy.data.objects.new('target', None)
target.location = centre
scene.collection.objects.link(target)
track = cam.constraints.new('TRACK_TO')
track.target, track.track_axis, track.up_axis = target, 'TRACK_NEGATIVE_Z', 'UP_Y'
scene.camera = cam

sun_data = bpy.data.lights.new('sun', 'SUN')
sun_data.energy = 3.0
sun = bpy.data.objects.new('sun', sun_data)
sun.rotation_euler = (0.7, 0.2, 0.6)
scene.collection.objects.link(sun)
world = bpy.data.worlds.new('world')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.02, 0.025, 0.03, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
scene.world = world

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = samples
# Ubuntu's Blender is built without OpenImageDenoise; denoising would abort the render.
scene.cycles.use_denoising = False
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = out_png
bpy.ops.render.render(write_still=True)
print('KINUX_RENDER ' + json.dumps({'tinted': sorted(tinted), 'meshes': len(meshes)}))
